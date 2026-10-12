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
    for key, default, low, high in [('seconds',20,1,60),('frames',6,1,8),('bytes',MAX_BYTES,1048576,MAX_BYTES),('timeout',25,3,90)]:
        value=request.get(key,default)
        if type(value) is not int or not low <= value <= high:
            raise LimitError('invalid_limits')
        result[key]=value
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

def download(url, root, bounds):
    os.environ['YTDLP_NO_PLUGINS']='1'
    import yt_dlp
    from yt_dlp.downloader import get_suitable_downloader
    from yt_dlp.downloader.http import HttpFD
    from yt_dlp.downloader.hls import HlsFD
    from yt_dlp.downloader.dash import DashSegmentsFD
    budget=Budget(bounds['bytes'])
    class BoundedDL(yt_dlp.YoutubeDL):
        def urlopen(self,req):
            return budget.wrap(super().urlopen(req))
        def process_info(self, info):
            # Reject external/ffmpeg downloaders before they start: every response
            # must pass the same Python byte budget. Single native stream only.
            if info.get('requested_formats') or info.get('is_live'):
                raise LimitError('unsupported_video')
            cls = get_suitable_downloader(info, self.params)
            if cls not in (HttpFD, HlsFD, DashSegmentsFD):
                raise LimitError('unsupported_downloader')
            return super().process_info(info)
    class Quiet:
        def debug(self,*args): pass
        def warning(self,*args): pass
        def error(self,*args): pass
    def progress(event):
        if (event.get('downloaded_bytes') or 0)>bounds['bytes']: raise LimitError('download_limit')
    opts={'outtmpl':os.path.join(root,'source.%(ext)s'),'format':'best[height<=720][ext=mp4]/best[height<=720]',
          'noplaylist':True,'playlist_items':'1','max_downloads':1,'max_filesize':bounds['bytes'],
          'socket_timeout':min(8,bounds['timeout']),'retries':0,'fragment_retries':0,'extractor_retries':0,
          'concurrent_fragment_downloads':1,'cachedir':False,'quiet':True,'no_warnings':True,
          'logger':Quiet(),'progress_hooks':[progress],'overwrites':False,
          'postprocessors':[],'external_downloader':None,'hls_prefer_native':True,
          'enable_file_urls':False,'usenetrc':False,'cookiefile':None,'cookiesfrombrowser':None,
          'allowed_extractors':['default'],'noprogress':True,'plugin_dirs':[],'js_runtimes':{},'remote_components':set()}
    with BoundedDL(opts) as dl:
        info=dl.extract_info(url,download=True)
    if not info or info.get('_type') in ('playlist','multi_video') or info.get('is_live'):
        raise LimitError('unsupported_video')
    candidates=[x for x in os.listdir(root) if x.startswith('source.') and not x.endswith(('.part','.ytdl'))]
    if len(candidates)!=1: raise LimitError('download_failed')
    data=bounded_file(root,candidates[0],bounds['bytes'])
    if not data: raise LimitError('empty_video')
    return data, budget.used

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
    command(args+['-map','0:v:0','-an','-t',str(seconds),'-vf',
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
        command(args+['-map','0:a:0','-vn','-t',str(seconds),'-af','aresample=16000,atrim=end_sample='+str(seconds*16000),
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
        return {'ok':True,'frames':frames,'audio':audio,'seconds':bounds['seconds'],'transferBytes':transferred}

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
