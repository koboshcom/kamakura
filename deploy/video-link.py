"""Owner-box-only video inspection. No shell, config, cookies, plugins or arbitrary file export."""
import base64
import ipaddress
import json
import math
import os
import resource
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import wave
from urllib.parse import urlsplit

MAX_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 1920 * 1080
class LimitError(Exception):
    pass

def public_url(url):
    if not isinstance(url, str) or len(url) > 2000 or any(ord(c) <= 32 or ord(c) == 127 for c in url) or '\\' in url:
        raise LimitError('invalid_url')
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.port not in (None, 80, 443):
        raise LimitError('invalid_url')
    ips = socket.getaddrinfo(p.hostname, p.port or (443 if p.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    if not ips or any(not ipaddress.ip_address(i[4][0]).is_global for i in ips):
        raise LimitError('nonpublic_url')
    return url

def limits(request):
    result = {}
    for key, default, low, high in [('seconds',5,1,60),('frames',2,1,8),('bytes',MAX_BYTES,1,MAX_BYTES),('timeout',25,3,90)]:
        value=request.get(key,default)
        if type(value) is not int or not low <= value <= high:
            raise LimitError('invalid_limits')
        result[key]=value
    start=request.get('start',0); processed=request.get('processedCap',60)
    if type(start) not in (int,float) or not math.isfinite(start) or not 0 <= start <= 3600 or type(processed) not in (int,float) or not 1 <= processed <= 120:
        raise LimitError('invalid_position_or_processed_cap')
    result.update(start=start,processedCap=processed)
    return result

def bounded_file(root, name, cap):
    # Fixed generated names only, open by directory fd and reject links/devices.
    if '/' in name or name in ('.','..'):
        raise LimitError('invalid_artifact')
    d=os.open(root, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        f=os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
        try:
            s=os.fstat(f)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_size > cap:
                raise LimitError('invalid_artifact')
            data=os.read(f,cap+1)
            if len(data)>cap: raise LimitError('artifact_limit')
            return data
        finally: os.close(f)
    finally: os.close(d)

class Budget:
    def __init__(self, maximum):
        self.maximum=maximum
        self.used=0
    def wrap(self,response):
        read=response.read
        def counted(size=-1):
            remaining=self.maximum-self.used
            data=read(min(size,remaining+1) if size is not None and size >= 0 else remaining+1)
            self.used+=len(data)
            if self.used>self.maximum: raise LimitError('transfer_limit')
            return data
        response.read=counted
        return response

def selected_segments(text, base_url, bounds):
    # Library parser, not guessed EXTINF/KEY/byte-range semantics.
    import m3u8
    playlist=m3u8.loads(text, uri=base_url)
    if playlist.is_variant or not playlist.is_endlist or len(playlist.segments)>100000:
        raise LimitError('partial_download_unavailable')
    selected=[]; cursor=0; begin=None
    start=bounds['start']; end=start+bounds['seconds']
    for segment in playlist.segments:
        duration=segment.duration
        if not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 0<duration<=10:
            raise LimitError('unsupported_segment_duration')
        after=cursor+duration
        if cursor < end and after > start:
            if segment.byterange or segment.init_section or segment.discontinuity or segment.gap_tag or (segment.key and segment.key.method!='NONE'):
                raise LimitError('partial_download_unavailable')
            if begin is None: begin=cursor
            selected.append(segment.absolute_uri)
        cursor=after
    if not selected or begin is None or cursor < end:
        raise LimitError('range_unavailable')
    # Decode only selected media, including bounded HLS seek/keyframe padding.
    taken=0; cursor2=0
    for segment in playlist.segments:
        after=cursor2+segment.duration
        if cursor2<end and after>start: taken+=segment.duration
        cursor2=after
    if taken*2 > bounds['processedCap']: raise LimitError('processed_limit')
    return selected, start-begin, taken*2, cursor

def download(url, root, bounds):
    os.environ['YTDLP_NO_PLUGINS']='1'
    import yt_dlp
    from yt_dlp.networking import Request
    budget=Budget(bounds['bytes'])
    class BoundedDL(yt_dlp.YoutubeDL):
        def urlopen(self,req):
            return budget.wrap(super().urlopen(req))
    class Quiet:
        def debug(self,*args): pass
        def warning(self,*args): pass
        def error(self,*args): pass
    opts={'format':'best[protocol=m3u8_native][height<=720]/best[protocol=m3u8][height<=720]',
          'noplaylist':True,'playlist_items':'1','socket_timeout':min(8,bounds['timeout']),
          'retries':0,'fragment_retries':0,'extractor_retries':0,'cachedir':False,'quiet':True,
          'logger':Quiet(),'postprocessors':[],'enable_file_urls':False,'usenetrc':False,
          'cookiefile':None,'cookiesfrombrowser':None,'plugin_dirs':[],'js_runtimes':{},
          'remote_components':set()}
    with BoundedDL(opts) as dl:
        info=dl.extract_info(url,download=False)
        if not info or info.get('_type') in ('playlist','multi_video') or info.get('is_live') or info.get('requested_formats') or info.get('protocol') not in ('m3u8','m3u8_native'):
            raise LimitError('partial_download_unavailable')
        headers=info.get('http_headers') or {}
        manifest_url=info['url']
        with dl.urlopen(Request(manifest_url,headers=headers)) as response:
            text=response.read().decode('utf-8','strict')
            actual_url=response.url
        segments,offset,processed,duration=selected_segments(text,actual_url,bounds)
        data=bytearray()
        for segment in segments:
            if urlsplit(segment).scheme not in ('http','https'): raise LimitError('invalid_segment')
            with dl.urlopen(Request(segment,headers=headers)) as response:
                while True:
                    part=response.read(65536)
                    if not part: break
                    data.extend(part)
        if not data: raise LimitError('empty_video')
        bounds.update(offset=offset,processedSeconds=processed,duration=duration)
        return bytes(data),budget.used

def command(argv, data, deadline, cap=65536):
    # The pipe is the only permitted decoder input protocol, including embedded references.
    remaining=deadline-time.monotonic()
    if remaining<=0: raise LimitError('timeout')
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err,start_new_session=False)
        try:
            p.communicate(input=data,timeout=remaining)
            if p.returncode: raise LimitError('decode_failed')
            out.seek(0); result=out.read(cap+1)
            if len(result)>cap: raise LimitError('decoder_output_limit')
            return result
        except subprocess.TimeoutExpired:
            p.kill();p.wait();raise LimitError('timeout')
        finally:
            if p.poll() is None: p.kill();p.wait()

def decode(data,root,bounds,deadline):
    probe=command(['ffprobe','-v','error','-protocol_whitelist','pipe','-max_alloc','33554432',
                  '-show_entries','stream=codec_type,width,height','-of','json','pipe:0'],data,deadline)
    streams=json.loads(probe).get('streams',[])
    videos=[s for s in streams if s.get('codec_type')=='video']
    if not videos or any(not (0 < s.get('width',0)*s.get('height',0) <= MAX_PIXELS) for s in videos):
        raise LimitError('pixel_limit')
    seconds=bounds['seconds']; frames=bounds['frames']
    args=['ffmpeg','-nostdin','-hide_banner','-v','error','-threads','1','-filter_threads','1',
          '-max_alloc','33554432','-protocol_whitelist','pipe','-max_pixels',str(MAX_PIXELS),'-i','pipe:0']
    # Hard output timestamp, frame/sample and file-size caps, independent of metadata duration.
    command(args+['-ss',str(bounds.get('offset',0)),'-map','0:v:0','-an','-t',str(seconds),'-vf',
                  'fps='+str(frames/seconds)+',scale=640:640:force_original_aspect_ratio=decrease',
                  '-frames:v',str(frames),'-q:v','5','-fs','524288',os.path.join(root,'frame-%02d.jpg')],data,deadline)
    images=[]
    for n in range(1,frames+1):
        name='frame-%02d.jpg'%n
        if os.path.exists(os.path.join(root,name)):
            image=bounded_file(root,name,524288)
            if not image.startswith(b'\xff\xd8') or not image.endswith(b'\xff\xd9'): raise LimitError('invalid_frame')
            images.append(base64.b64encode(image).decode())
    if not images: raise LimitError('no_frames')
    audio=None
    if any(s.get('codec_type')=='audio' for s in streams):
        command(args+['-ss',str(bounds.get('offset',0)),'-map','0:a:0','-vn','-t',str(seconds),'-af','aresample=16000,atrim=end_sample='+str(seconds*16000),
                      '-ac','1','-ar','16000','-c:a','pcm_s16le','-fs',str(seconds*32000+1024),
                      os.path.join(root,'audio.wav')],data,deadline)
        wav=bounded_file(root,'audio.wav',seconds*32000+1024)
        import io
        with wave.open(io.BytesIO(wav)) as w:
            if w.getnchannels()!=1 or w.getframerate()!=16000 or w.getsampwidth()!=2 or w.getnframes()>seconds*16000:
                raise LimitError('audio_limit')
        audio=base64.b64encode(wav).decode()
    return images,audio

def inspect(request, downloader=download, decoder=decode):
    bounds=limits(request); url=public_url(request.get('url'))
    deadline=time.monotonic()+bounds['timeout']
    with tempfile.TemporaryDirectory(prefix='kamakura-video-',dir='/tmp') as root:
        os.chmod(root,0o700)
        data, transferred=downloader(url,root,bounds)
        if len(data)>bounds['bytes'] or transferred>bounds['bytes']: raise LimitError('download_limit')
        frames,audio=decoder(data,root,bounds,deadline)
        return {'ok':True,'frames':frames,'audio':audio,'seconds':bounds['seconds'],'transferBytes':transferred,'start':bounds['start'],'processedSeconds':bounds.get('processedSeconds',bounds['seconds']),'duration':bounds.get('duration')}

def main():
    # Killable helper/children, no cached configs or environment credential inheritance.
    os.umask(0o077)
    request=json.loads(base64.b64decode(sys.argv[1],validate=True)); bounds=limits(request)
    resource.setrlimit(resource.RLIMIT_FSIZE,(bounds['bytes'],bounds['bytes']))
    resource.setrlimit(resource.RLIMIT_CPU,(bounds['timeout']+1,bounds['timeout']+2))
    resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    def timeout(*_): raise LimitError('timeout')
    signal.signal(signal.SIGALRM,timeout);signal.alarm(bounds['timeout'])
    try: result=inspect(request)
    except BaseException as e:
        # No media URLs, local paths, credentials or library tracebacks cross to the model.
        result={'ok':False,'error':str(e) if isinstance(e,LimitError) else 'unavailable_or_blocked'}
    finally: signal.alarm(0)
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__': main()
