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
TRACE={'stage':'validate','transferBytes':0}
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
            if remaining<=0: raise LimitError('transfer_limit')
            data=read(min(size,remaining) if size is not None and size >= 0 else remaining)
            self.used+=len(data)
            TRACE['transferBytes']=self.used
            if self.used>=self.maximum: raise LimitError('transfer_limit')
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
            if segment.byterange or segment.discontinuity or segment.gap_tag or (segment.key and segment.key.method!='NONE'):
                raise LimitError('partial_download_unavailable')
            if begin is None: begin=cursor
            if segment.init_section and segment.init_section.absolute_uri not in selected:
                if segment.init_section.byterange:raise LimitError('unsupported_initialization_range')
                selected.append(segment.init_section.absolute_uri)
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

def format_options():
    # Prefer small muxed progressive, then small DASH video + audio. Never DRM.
    return 'worst[height>=144][height<=720][vcodec!=none][acodec!=none]/worstvideo[height>=144][height<=720]+worstaudio/worstvideo[height<=720]'

def read_body(dl, url, headers=None, range_header=None):
    from yt_dlp.networking import Request
    if urlsplit(url).scheme not in ('http','https'): raise LimitError('invalid_media_protocol')
    headers=dict(headers or {})
    if any(str(k).lower() in ('authorization','cookie') or '\r' in str(k)+str(v) or '\n' in str(k)+str(v) for k,v in headers.items()):
        raise LimitError('unsafe_media_headers')
    if range_header: headers['Range']=range_header
    with dl.urlopen(Request(url,headers=headers)) as response:
        chunks=[]
        while True:
            data=response.read(65536)
            if not data: break
            chunks.append(data)
        return b''.join(chunks),getattr(response,'status',200),dict(getattr(response,'headers',{}))

def progressive(dl, info, root, bounds, deadline):
    # Range-fetch a small progressive prefix. Front-indexed MP4 is decodable
    # without the rest of the source. Missing/end indexes explicitly fall back
    # to the complete file, still through the SAME response-body budget.
    path=os.path.join(root,'source.mp4'); chunk=262144; position=0; data=bytearray()
    duration=info.get('duration'); full=False
    while position < bounds['bytes']:
        part,status,headers=read_body(dl,info['url'],info.get('http_headers'),f'bytes={position}-{position+chunk-1}')
        if status!=206:
            if position: data=bytearray()
            data.extend(part);full=True;break
        content_range=next((v for k,v in headers.items() if k.lower()=='content-range'),'')
        import re
        match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range)
        if not match or int(match[1])!=position or len(part)!=int(match[2])-position+1: raise LimitError('invalid_http_range')
        data.extend(part);position+=len(part);full=position>=int(match[3])
        with open(path,'wb') as f:f.write(data)
        if full:break
        # ffprobe reads packets only from the prefix, with a strict subprocess
        # deadline. The requested end must exist and include a video packet.
        try:
            meta=json.loads(command(['ffprobe','-v','quiet','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts',
                '-read_intervals',str(bounds['start'])+'%+'+str(bounds['seconds']+2),
                '-show_entries','packet=pts_time,codec_type','-of','json',path],b'',deadline,1048576))
            packets=meta.get('packets',[])
            if any(x.get('codec_type')=='video' and float(x.get('pts_time','-inf'))>=bounds['start']+bounds['seconds'] for x in packets):
                bounds['downloadMode']='progressive-range-prefix';break
        except (LimitError,ValueError,TypeError):pass
        # At most four prefix probes. Thereafter a whole-file fallback is
        # streamed in ranges instead of pretending an unsupported seek worked.
        if position>=1048576:
            while not full:
                part,status,headers=read_body(dl,info['url'],info.get('http_headers'),f'bytes={position}-{position+chunk-1}')
                if status!=206:
                    data=bytearray(part);full=True;break
                content_range=next((v for k,v in headers.items() if k.lower()=='content-range'),'')
                match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range)
                if not match or int(match[1])!=position or len(part)!=int(match[2])-position+1:raise LimitError('invalid_http_range')
                data.extend(part);position+=len(part);full=position>=int(match[3])
            break
    if not data:raise LimitError('empty_video')
    if full:bounds['downloadMode']='whole-file-bandwidth-capped-fallback'
    # Local input seek uses the MP4 index, not decoding the preceding minute.
    with open(path,'wb') as f:f.write(data)
    bounds.update(offset=bounds['start'],duration=duration)
    return path

def dash_fragment_selection(info, bounds):
    fragments=info.get('fragments') or []
    selected=[];cursor=0;begin=None;covered=0
    for fragment in fragments:
        if fragment.get('decrypt_info'):raise LimitError('drm_unsupported')
        duration=fragment.get('duration')
        if duration is None:
            if cursor or selected:raise LimitError('dash_timeline_unavailable')
            selected.append(fragment);continue # initialization segment
        if not isinstance(duration,(int,float)) or not math.isfinite(duration) or not 0<duration<=10:raise LimitError('dash_timeline_unavailable')
        after=cursor+duration
        if cursor<bounds['start']+bounds['seconds'] and after>bounds['start']:
            if begin is None:begin=cursor
            selected.append(fragment);covered+=duration
        cursor=after
    if begin is None or cursor<bounds['start']+bounds['seconds']:raise LimitError('dash_timeline_unavailable')
    return selected,bounds['start']-begin,covered,cursor

def dash(dl, info, root, bounds, deadline):
    formats=info.get('requested_formats') or [info];paths=[];offsets=[];processed=0
    for i,fmt in enumerate(formats):
        if fmt.get('has_drm'):raise LimitError('drm_unsupported')
        try:
            fragments,offset,covered,duration=dash_fragment_selection(fmt,bounds)
            bounds['downloadMode']='dash-selected-fragments'
        except LimitError as error:
            if str(error)=='drm_unsupported':raise
            # Unknown fragment timeline: whole-file fallback uses native Python
            # HTTP fetching only, no external unmetered downloader.
            fragments=fmt.get('fragments') or []
            if not fragments:raise LimitError('dash_timeline_unavailable')
            offset=bounds['start'];covered=bounds['seconds']+5;duration=info.get('duration')
            bounds['downloadMode']='whole-file-bandwidth-capped-fallback'
        if not fragments or len(fragments)>100000:raise LimitError('fragment_limit')
        path=os.path.join(root,'dash-'+str(i)+'.mp4')
        with open(path,'wb') as f:
            from urllib.parse import urljoin
            for fragment in fragments:
                if fragment.get('decrypt_info'):raise LimitError('drm_unsupported')
                media_url=fragment.get('url') or urljoin(fmt.get('fragment_base_url') or fmt['url'],fragment.get('path',''))
                byte_range=fragment.get('range')
                body,_,_=read_body(dl,media_url,fmt.get('http_headers'),str(byte_range) if byte_range else None)
                f.write(body)
        paths.append(path);offsets.append(offset);processed=max(processed,covered*2)
    if len(set(offsets))>1:raise LimitError('dash_unaligned_streams')
    if processed>bounds['processedCap']:raise LimitError('processed_limit')
    output=os.path.join(root,'dash-merged.mkv')
    args=['ffmpeg','-nostdin','-v','error','-threads','1']
    for path in paths:args+=['-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts','-i',path]
    for i in range(len(paths)):args+=['-map',str(i)+':0']
    args+=['-c','copy','-fs',str(bounds['bytes']),output]
    command(args,b'',deadline)
    bounds.update(offset=offsets[0],processedSeconds=processed,duration=duration)
    return output

def hls_data(dl,fmt,bounds):
    from yt_dlp.networking import Request
    headers=fmt.get('http_headers') or {}
    if any(str(k).lower() in ('authorization','cookie') for k in headers):raise LimitError('unsafe_media_headers')
    with dl.urlopen(Request(fmt['url'],headers=headers)) as response:
        text=response.read().decode('utf-8','strict');actual_url=response.url
    segments,offset,processed,duration=selected_segments(text,actual_url,bounds)
    data=bytearray()
    for segment in segments:
        body,_,_=read_body(dl,segment,headers);data.extend(body)
    return bytes(data),offset,processed,duration

def multiple_hls(dl,info,root,bounds,deadline):
    paths=[];offsets=[];processed=0;duration=None
    for i,fmt in enumerate(info['requested_formats']):
        data,offset,used_seconds,duration=hls_data(dl,fmt,bounds)
        path=os.path.join(root,'hls-'+str(i)+'.mp4')
        with open(path,'wb') as f:f.write(data)
        paths.append(path);offsets.append(offset);processed=max(processed,used_seconds)
    # Seeking each stream separately permits independent segment boundaries.
    output=os.path.join(root,'hls-merged.mkv')
    args=['ffmpeg','-nostdin','-v','error','-threads','1']
    for path,offset in zip(paths,offsets):args+=['-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts','-max_pixels',str(MAX_PIXELS),'-ss',str(offset),'-i',path]
    for i in range(len(paths)):args+=['-map',str(i)+':0']
    # Accurate seek for separate HLS stream boundaries, not stream-copy preroll.
    processed+=2*bounds['seconds']
    if processed>bounds['processedCap']:raise LimitError('processed_limit')
    args+=['-t',str(bounds['seconds']),'-c:v','libx264','-threads','1','-c:a','aac','-fs',str(bounds['bytes']),output]
    command(args,b'',deadline)
    bounds.update(offset=0,processedSeconds=processed,duration=duration,downloadMode='hls-selected-segments')
    return output

def download(url, root, bounds):
    os.environ['YTDLP_NO_PLUGINS']='1'
    import yt_dlp
    from yt_dlp.networking import Request
    budget=Budget(bounds['bytes']);deadline=time.monotonic()+bounds['timeout']
    class BoundedDL(yt_dlp.YoutubeDL):
        def urlopen(self,req):
            return budget.wrap(super().urlopen(req))
    class Quiet:
        def debug(self,*args): pass
        def warning(self,*args): pass
        def error(self,*args): pass
    opts={'format':format_options(),
          'noplaylist':True,'playlist_items':'1','socket_timeout':min(8,bounds['timeout']),
          'retries':0,'fragment_retries':0,'extractor_retries':0,'cachedir':False,'quiet':True,
          'logger':Quiet(),'postprocessors':[],'enable_file_urls':False,'usenetrc':False,
          'cookiefile':None,'cookiesfrombrowser':None,'plugin_dirs':[],'js_runtimes':{},
          'remote_components':set(),'allow_unplayable_formats':False}
    with BoundedDL(opts) as dl:
        TRACE['stage']='extract_metadata'
        info=dl.extract_info(url,download=False)
        TRACE['stage']='select_format'
        TRACE['sourceFormat']={k:str(info.get(k,''))[:100] for k in ['protocol','ext','format_id']} if info else None
        TRACE['formats']=[{k:str(f.get(k,''))[:100] for k in ['protocol','ext','format_id']} for f in (info or {}).get('requested_formats',[])[:2]]
        if not info or info.get('_type') in ('playlist','multi_video') or info.get('is_live') or info.get('live_status') in ('is_live','is_upcoming','post_live'):
            raise LimitError('live_or_playlist_unsupported')
        if info.get('has_drm') or any(f.get('has_drm') for f in info.get('requested_formats',[])):
            raise LimitError('drm_unsupported')
        bounds['sourceFormat']={'protocol':info.get('protocol'),'ext':info.get('ext'),'formatId':info.get('format_id')}
        TRACE['stage']='download'
        protocol=info.get('protocol') or urlsplit(info.get('url','')).scheme
        if 'http_dash_segments' in protocol or info.get('fragments'):
            data=dash(dl,info,root,bounds,deadline)
        elif protocol in ('http','https') and not info.get('requested_formats'):
            # Prefix range MP4; other single-file containers use the authorized
            # bounded whole fallback, followed by input-seek decoding only.
            if info.get('ext')=='mp4':data=progressive(dl,info,root,bounds,deadline)
            else:
                body,_,_=read_body(dl,info['url'],info.get('http_headers'))
                data=os.path.join(root,'whole-source.bin')
                with open(data,'wb') as f:f.write(body)
                bounds.update(offset=bounds['start'],duration=info.get('duration'),downloadMode='whole-file-bandwidth-capped-fallback')
        elif protocol in ('m3u8','m3u8_native') and not info.get('requested_formats'):
            data,offset,processed,duration=hls_data(dl,info,bounds)
            bounds.update(offset=offset,processedSeconds=processed,duration=duration,downloadMode='hls-selected-segments')
        elif info.get('requested_formats') and all(f.get('protocol') in ('m3u8','m3u8_native') for f in info['requested_formats']):
            data=multiple_hls(dl,info,root,bounds,deadline)
        elif info.get('requested_formats') and all(f.get('protocol') in ('http','https') for f in info['requested_formats']):
            # Separate progressive video/audio also supported under same budget.
            fake=dict(info);fake['requested_formats']=[dict(f,fragments=[{'url':f['url']}]) for f in info['requested_formats']]
            data=dash(dl,fake,root,bounds,deadline)
        else:raise LimitError('unsupported_source_protocol')
        if not data:raise LimitError('empty_video')
        if 'processedSeconds' not in bounds:
            processed=2*(bounds['seconds']+5) # conservative keyframe padding
            if processed>bounds['processedCap']:raise LimitError('processed_limit')
            bounds['processedSeconds']=processed
        return data,budget.used

def command(argv, data, deadline, cap=65536):
    # Every ffmpeg/ffprobe invocation is local-input only. Network media is
    # fetched by the metered Python client, never an external downloader.
    remaining=deadline-time.monotonic()
    if remaining<=0: raise LimitError('timeout')
    import threading
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=out,stderr=err,start_new_session=False)
        stop=threading.Event();overflow=[]
        def monitor():
            while not stop.wait(.01):
                if os.fstat(out.fileno()).st_size>cap or os.fstat(err.fileno()).st_size>1048576:
                    overflow.append(True);p.kill();return
        watcher=threading.Thread(target=monitor,daemon=True);watcher.start()
        try:
            p.communicate(input=data,timeout=remaining)
            if overflow or os.fstat(out.fileno()).st_size>cap or os.fstat(err.fileno()).st_size>1048576:raise LimitError('decoder_output_limit')
            if p.returncode: raise LimitError('decode_failed')
            out.seek(0); result=out.read(cap+1)
            if len(result)>cap: raise LimitError('decoder_output_limit')
            return result
        except subprocess.TimeoutExpired:
            p.kill();p.wait();raise LimitError('timeout')
        finally:
            if p.poll() is None:p.kill();p.wait()
            stop.set();watcher.join(timeout=1)

def decode(data,root,bounds,deadline):
    local=isinstance(data,str)
    if local and (os.path.dirname(data)!=root or os.path.islink(data)):raise LimitError('invalid_decoder_input')
    protocol='file' if local else 'pipe'
    source=data if local else 'pipe:0'; payload=b'' if local else data
    probe=command(['ffprobe','-v','error','-protocol_whitelist',protocol,'-max_alloc','33554432',
                  *(['-format_whitelist','mov,matroska,mpegts,avi,ogg,mp3,wav'] if local else []),'-show_entries','stream=codec_type,width,height','-of','json',source],payload,deadline)
    streams=json.loads(probe).get('streams',[])
    videos=[s for s in streams if s.get('codec_type')=='video']
    if not videos or any(not (0 < s.get('width',0)*s.get('height',0) <= MAX_PIXELS) for s in videos):
        raise LimitError('pixel_limit')
    seconds=bounds['seconds']; frames=bounds['frames']
    if local:
        # Use actual demuxer seek point, not assumed metadata/keyframe padding.
        packet_meta=json.loads(command(['ffprobe','-v','quiet','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts',
            '-read_intervals',str(bounds.get('offset',0))+'%+'+str(seconds),
            '-show_entries','packet=pts_time,codec_type','-of','json',source],b'',deadline,1048576))
        packets=packet_meta.get('packets',[])
        starts=[float(p['pts_time']) for p in packets if p.get('codec_type') in ('video','audio') and p.get('pts_time') is not None]
        if not starts or any(not math.isfinite(t) for t in starts):raise LimitError('seek_coverage_unavailable')
        padding=max(0,bounds.get('offset',0)-min(starts))
        processed=2*(seconds+padding)
        if processed>bounds['processedCap']:raise LimitError('processed_limit')
        bounds['processedSeconds']=max(bounds.get('processedSeconds',0),processed)

    args=['ffmpeg','-nostdin','-hide_banner','-v','error','-threads','1','-filter_threads','1',
          '-max_alloc','33554432','-protocol_whitelist',protocol,'-max_pixels',str(MAX_PIXELS)]
    if local: args+=['-format_whitelist','mov,matroska,mpegts,avi,ogg,mp3,wav','-ss',str(bounds.get('offset',0))]
    args+=['-i',source]
    offset=0 if local else bounds.get('offset',0)
    # Hard output timestamp, frame/sample and file-size caps, independent of metadata duration.
    command(args+['-ss',str(offset),'-map','0:v:0','-an','-t',str(seconds),'-vf',
                  'fps='+str(frames/seconds)+',scale=640:640:force_original_aspect_ratio=decrease',
                  '-frames:v',str(frames),'-q:v','5','-fs','524288',os.path.join(root,'frame-%02d.jpg')],payload,deadline)
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
        command(args+['-ss',str(offset),'-map','0:a:0','-vn','-t',str(seconds),'-af','aresample=16000,atrim=end_sample='+str(seconds*16000),
                      '-ac','1','-ar','16000','-c:a','pcm_s16le','-fs',str(seconds*32000+1024),
                      os.path.join(root,'audio.wav')],payload,deadline)
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
        if (not isinstance(data,str) and len(data)>bounds['bytes']) or transferred>bounds['bytes']: raise LimitError('download_limit')
        TRACE['stage']='ffmpeg_decode'
        frames,audio=decoder(data,root,bounds,deadline)
        TRACE['stage']='complete'
        return {'ok':True,'frames':frames,'audio':audio,'seconds':bounds['seconds'],'transferBytes':transferred,'start':bounds['start'],'processedSeconds':bounds.get('processedSeconds',bounds['seconds']),'duration':bounds.get('duration'),'downloadMode':bounds.get('downloadMode'),'sourceFormat':bounds.get('sourceFormat')}

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
        result={'ok':False,'error':str(e) if isinstance(e,LimitError) else 'unavailable_or_blocked',**TRACE}
    finally: signal.alarm(0)
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__': main()
