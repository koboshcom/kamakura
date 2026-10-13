"""Owner-box-only video inspection. No shell, config, cookies, plugins or arbitrary file export."""
import base64
import hashlib
import re
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
    for key, default, low, high in [('seconds',5,1,3600 if request.get('nativeClip') is True else 60),('frames',2,1,8),('bytes',MAX_BYTES,1,MAX_BYTES),('timeout',25,3,90)]:
        value=request.get(key,default)
        if (type(value) not in (int,float) if key=='seconds' and request.get('nativeClip') is True else type(value) is not int) or not math.isfinite(value) or not low <= value <= high:
            raise LimitError('invalid_limits')
        result[key]=value
    native=request.get('nativeConfig')
    if native is not None:
        if request.get('nativeClip') is not True or not isinstance(native,dict):raise LimitError('invalid_native_config')
        fps=native.get('fps',1);dimension=native.get('dimension',360);maximum=native.get('maxShort',300)
        if type(fps) not in (int,float) or not math.isfinite(fps) or not 0.1<=fps<=1:raise LimitError('invalid_native_fps')
        if type(dimension) is not int or dimension not in (360,480) or type(maximum) is not int or not 1<=maximum<=300:raise LimitError('invalid_native_config')
        if type(native.get('explicitRange',False)) is not bool or native.get('version')!='whole-short-v2':raise LimitError('invalid_native_config')
        long_max=native.get('maxLong',maximum)
        if type(long_max) is not int or not maximum<=long_max<=3600:raise LimitError('invalid_native_config')
        unique=native.get('uniqueCap',20);prior=native.get('priorRanges',[])
        if type(unique) not in (int,float) or not math.isfinite(unique) or not 1<=unique<=long_max or not isinstance(prior,list) or len(prior)>32:raise LimitError('invalid_native_config')
        if any(not isinstance(pair,list) or len(pair)!=2 or any(type(x) not in (int,float) or not math.isfinite(x) for x in pair) or not 0<=pair[0]<pair[1]<=3600 for pair in prior):raise LimitError('invalid_native_config')
        result['nativeConfig']=dict(native,maxLong=long_max,uniqueCap=unique,priorRanges=prior)
    start=request.get('start',0); processed=request.get('processedCap',60)
    if type(start) not in (int,float) or not math.isfinite(start) or not 0 <= start <= 3600 or type(processed) not in (int,float) or not 1 <= processed <= (1000000000 if native is not None else 120):
        raise LimitError('invalid_position_or_processed_cap')
    result.update(start=start,processedCap=processed)
    overview=request.get('overview',False)
    if type(overview) is not bool:raise LimitError('invalid_overview')
    result['overview']=overview
    for key in ('scene','noAudio'):
        result[key]=request.get(key,False)
        if type(result[key]) is not bool:raise LimitError('invalid_scene_mode')
    config=request.get('overviewConfig',{})
    if not isinstance(config,dict):raise LimitError('invalid_overview_config')
    for key,default,low,high in [('count',4,1,6),('resolution',320,48,640),('duration',3600,1,3600),('overviewBytes',8388608,1,MAX_BYTES),('descriptionChars',4000,1,8000),('chapters',24,1,64),('captionBytes',65536,1,262144),('captionChars',12000,1,24000),('captionTracks',1,1,2),('captionLanguages',2,1,4),('dedupeThreshold',2,1,16),('scanSeconds',5,1,10)]:
        value=config.get(key,default)
        if type(value) is not int or not low<=value<=high:raise LimitError('invalid_overview_config')
        result[key]=value
    threshold=config.get('sceneThreshold',0.35)
    if type(threshold) not in (int,float) or not math.isfinite(threshold) or not 0.05<=threshold<=1:raise LimitError('invalid_scene_threshold')
    result['sceneThreshold']=threshold
    result['autoCaptions']=config.get('autoCaptions',True)
    if type(result['autoCaptions']) is not bool:raise LimitError('invalid_overview_config')
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
    return 'worst[height>=144][height<=720][vcodec!=none][acodec!=none]/worst[width>=144][width<=720][height<=1280][vcodec!=none][acodec!=none]/worstvideo[height>=144][height<=720]+worstaudio/worstvideo[height<=720]'

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
            if bounds.get('noWhole'):raise LimitError('bounded_seek_unavailable')
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
            meta=json.loads(command(['ffprobe','-v','quiet','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,aac',
                '-read_intervals',str(bounds['start'])+'%+'+str(bounds['seconds']+2),
                '-show_entries','packet=pts_time,codec_type','-of','json',path],b'',deadline,1048576))
            packets=meta.get('packets',[])
            if any(x.get('codec_type')=='video' and float(x.get('pts_time','-inf'))>=bounds['start']+bounds['seconds'] for x in packets):
                bounds['downloadMode']='progressive-range-prefix';break
        except (LimitError,ValueError,TypeError):pass
        # At most four prefix probes. Thereafter a whole-file fallback is
        # streamed in ranges instead of pretending an unsupported seek worked.
        if position>=1048576:
            if bounds.get('noWhole'):raise LimitError('bounded_seek_unavailable')
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
            if str(error)=='drm_unsupported' or bounds.get('noWhole'):raise
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
    for path in paths:args+=['-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,aac','-i',path]
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
    for path,offset in zip(paths,offsets):args+=['-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,aac','-max_pixels',str(MAX_PIXELS),'-ss',str(offset),'-i',path]
    for i in range(len(paths)):args+=['-map',str(i)+':0']
    # Accurate seek for separate HLS stream boundaries, not stream-copy preroll.
    processed+=2*bounds['seconds']
    if processed>bounds['processedCap']:raise LimitError('processed_limit')
    args+=['-t',str(bounds['seconds']),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-threads','1','-c:a','aac','-fs',str(bounds['bytes']),output]
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
        if bounds.get('nativeConfig'):
            source_duration=info.get('duration')
            if type(source_duration) not in (int,float) or not math.isfinite(source_duration) or source_duration<=0:
                # Only local, metered media can be probed. Never ffprobe a network URL.
                if info.get('protocol') not in ('http','https') or info.get('requested_formats'):
                    raise LimitError('native_source_duration_unknown')
                body,_,_=read_body(dl,info['url'],info.get('http_headers'))
                probe_path=os.path.join(root,'duration-probe.bin')
                with open(probe_path,'wb') as f:f.write(body)
                try:
                    probe=json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,avi,ogg','-show_entries','format=duration','-of','json',probe_path],b'',deadline))
                    source_duration=float(probe.get('format',{}).get('duration','nan'))
                except Exception:raise LimitError('native_source_duration_unknown')
                info['duration']=source_duration
            plan_native(bounds,source_duration,[url,info.get('extractor_key'),info.get('id'),source_duration,info.get('format_id')])
            # No publisher title/caption content is used as visual evidence or extra network here.
        else:bounds['metadata']=metadata(dl,info,bounds)
        TRACE['stage']='download'
        protocol=info.get('protocol') or urlsplit(info.get('url','')).scheme
        if 'http_dash_segments' in protocol or info.get('fragments'):
            data=dash(dl,info,root,bounds,deadline)
        elif protocol in ('http','https') and not info.get('requested_formats'):
            # Prefix range MP4; other single-file containers use the authorized
            # bounded whole fallback, followed by input-seek decoding only.
            if info.get('ext')=='mp4':data=progressive(dl,info,root,bounds,deadline)
            else:
                if bounds.get('noWhole'):raise LimitError('bounded_seek_unavailable')
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

def command(argv, data, deadline, cap=65536, capture=False):
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
            if capture:
                err.seek(0);return result,err.read(1048576)
            return result
        except subprocess.TimeoutExpired:
            p.kill();p.wait();raise LimitError('timeout')
        finally:
            if p.poll() is None:p.kill();p.wait()
            stop.set();watcher.join(timeout=1)

def dedupe_frames(images,times,threshold=2):
    # dHash alone conflates different solid colours; retain materially different RGB means.
    import io,dhash
    from PIL import Image,ImageStat
    dhash.force_pil()
    kept=[];pts=[];hashes=[];means=[];skipped=[]
    for encoded,timestamp in sorted(zip(images,times),key=lambda pair:pair[1]):
        raw=base64.b64decode(encoded,validate=True)
        with Image.open(io.BytesIO(raw)) as im:
            if im.width*im.height>MAX_PIXELS:raise LimitError('pixel_limit')
            im=im.convert('RGB');h=dhash.dhash_int(im);mean=ImageStat.Stat(im.resize((8,8))).mean
        if any(dhash.get_num_bits_different(h,old)<=threshold and max(abs(a-b) for a,b in zip(mean,m))<8 for old,m in zip(hashes,means)):
            skipped.append(timestamp);continue
        kept.append(encoded);pts.append(timestamp);hashes.append(h);means.append(mean)
    return kept,pts,skipped

def scene_frames(args,payload,root,bounds,deadline,offset):
    seconds=bounds['seconds'];count=bounds['frames']
    # One local bounded decode. Scene changes plus a periodic fallback. Output cap may stop before interval end.
    gap=seconds/count
    vf="scale="+str(bounds['resolution'])+":"+str(bounds['resolution'])+":force_original_aspect_ratio=decrease,select='eq(n,0)+gt(scene,"+str(bounds['sceneThreshold'])+")+gte(t-prev_selected_t,"+str(gap)+")',showinfo"
    _,logs=command(args+['-v','info','-ss',str(offset),'-map','0:v:0','-an','-t',str(seconds),'-vf',vf,
        '-vsync','0','-frames:v',str(count),'-q:v','5','-fs','524288',os.path.join(root,'scene-%02d.jpg')],payload,deadline,capture=True)
    relative=[float(t) for t in re.findall(rb'pts_time:([0-9.eE+-]+)',logs)]
    images=[];times=[]
    for i,t in enumerate(relative[:count],1):
        name='scene-%02d.jpg'%i
        if not os.path.exists(os.path.join(root,name)):break
        raw=bounded_file(root,name,524288)
        if not raw.startswith(b'\xff\xd8') or not raw.endswith(b'\xff\xd9'):raise LimitError('invalid_frame')
        # PTS at decoder output, normalized to the requested seek origin.
        stamp=bounds['start']+t-offset
        if not math.isfinite(stamp) or stamp<bounds['start']-0.1 or stamp>bounds['start']+seconds+0.1:raise LimitError('frame_timestamp_limit')
        images.append(base64.b64encode(raw).decode());times.append(round(max(bounds['start'],stamp),6))
    if not images:raise LimitError('scene_no_frames')
    sampled=len(images);images,times,skipped=dedupe_frames(images,times,bounds['dedupeThreshold'])
    bounds.update(frameTimes=times,sampledFrames=sampled,scanRange=[bounds['start'],bounds['start']+seconds],
        coverageNotes=['Scene-cut plus periodic fallback; decoder PTS normalized to seek origin, sparse samples, not full watching.',
            'Scanned window budget '+str(bounds['start'])+'-'+str(bounds['start']+seconds)+'s; output frame cap may stop scanning early at '+str(max(relative) if relative else 0)+'s relative PTS.',
            'Near-duplicate skipped sample times '+str(skipped)])
    return images,None

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
        packet_meta=json.loads(command(['ffprobe','-v','quiet','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,aac',
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
    if bounds.get('scene'):return scene_frames(args,payload,root,bounds,deadline,offset)
    # Hard output timestamp, frame/sample and file-size caps, independent of metadata duration.
    command(args+['-ss',str(offset),'-map','0:v:0','-an','-t',str(seconds),'-vf',
                  'fps='+str(frames/seconds)+',scale='+str(bounds.get('resolution',640))+':'+str(bounds.get('resolution',640))+':force_original_aspect_ratio=decrease',
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
    if not bounds.get('noAudio') and any(s.get('codec_type')=='audio' for s in streams):
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

def uploaded_source(upload, root, bounds, deadline):
    if not isinstance(upload,dict) or not re.fullmatch('[a-f0-9]{48}',upload.get('id','')) or not re.fullmatch('[a-f0-9]{64}',upload.get('sha256','')):
        raise LimitError('invalid_upload')
    size=upload.get('bytes')
    if type(size) is not int or not 1<=size<=MAX_BYTES:raise LimitError('upload_limit')
    path='/tmp/kamakura-upload-'+upload['id']+'.bin'
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    target=os.path.join(root,'input')
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=size:raise LimitError('invalid_upload')
        hasher=hashlib.sha256();total=0
        with open(target,'xb') as out:
            while True:
                if time.monotonic()>deadline:raise LimitError('timeout')
                data=os.read(fd,65536)
                if not data:break
                total+=len(data)
                if total>size:raise LimitError('upload_limit')
                hasher.update(data);out.write(data)
        if total!=size or hasher.hexdigest()!=upload['sha256']:raise LimitError('upload_integrity')
    finally:os.close(fd)
    meta=json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file','-format_whitelist','mov,matroska,mpegts,avi,ogg','-show_entries','format=duration','-of','json',target],b'',deadline))
    duration=float(meta.get('format',{}).get('duration','nan'))
    if not math.isfinite(duration) or duration<=0 or bounds['start']>=duration:raise LimitError('upload_duration')
    if bounds.get('nativeConfig'):plan_native(bounds,duration,['upload',upload['sha256'],duration])
    # Last chunk must not claim seconds beyond actual source duration.
    bounds.update(offset=bounds['start'],duration=duration,downloadMode='local-upload',processedSeconds=bounds['seconds'])
    return target,0


def text_field(value, cap):
    value=str(value or '')
    return ''.join(c for c in value if ord(c)>=32 or c in '\n\t')[:cap]

def capped_body(dl,url,headers,cap):
    from yt_dlp.networking import Request
    if urlsplit(url).scheme not in ('http','https'):raise LimitError('invalid_media_protocol')
    headers=dict(headers or {})
    if any(str(k).lower() in ('cookie','authorization') or '\\r' in str(k)+str(v) or '\\n' in str(k)+str(v) for k,v in headers.items()):raise LimitError('unsafe_media_headers')
    with dl.urlopen(Request(url,headers=headers)) as response:
        data=bytearray()
        while len(data)<cap:
            part=response.read(min(65536,cap-len(data)))
            if not part:return bytes(data),False
            data.extend(part)
        return bytes(data),True

def metadata(dl,info,bounds):
    duration=info.get('duration')
    if not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<=0:duration=None
    chapters=[]
    for ch in (info.get('chapters') or [])[:bounds['chapters']]:
        a=ch.get('start_time');b=ch.get('end_time')
        if isinstance(a,(int,float)) and math.isfinite(a) and a>=0 and isinstance(b,(int,float)) and math.isfinite(b) and b>=a:
            chapters.append({'start':a,'end':b,'title':text_field(ch.get('title'),200)})
    result={'provenance':'yt-dlp extractor metadata, untrusted publisher text; TITLE IS NOT VISUAL PROOF; captions are not verified actual speech or visual proof',
            'title':text_field(info.get('title'),500),'channel':text_field(info.get('channel') or info.get('uploader'),300),
            'description':text_field(info.get('description'),bounds['descriptionChars']),'duration':duration,
            'descriptionTruncated':len(str(info.get('description') or ''))>bounds['descriptionChars'],
            'chapters':chapters,'chaptersTruncated':len(info.get('chapters') or [])>bounds['chapters'],
            'captions':{'status':'unavailable','tracks':[]}}
    sources=[('manual',info.get('subtitles') or {})]
    if bounds['autoCaptions']:sources.append(('automatic',info.get('automatic_captions') or {}))
    remaining=bounds['captionBytes'];chars=bounds['captionChars'];languages=0
    for kind,tracks in sources:
        for language in sorted(tracks,key=lambda l:(l not in ('en','ja'),l)):
            if language=='live_chat':continue
            if languages>=bounds['captionLanguages'] or len(result['captions']['tracks'])>=bounds['captionTracks'] or remaining<=0 or chars<=0:break
            options=[t for t in tracks[language] if t.get('ext') in ('vtt','json3','srv3','srt')]
            if not options:continue
            languages+=1
            track=sorted(options,key=lambda t: t.get('ext')!='vtt')[0]
            try:
                body,truncated=capped_body(dl,track['url'],info.get('http_headers'),remaining);remaining-=len(body)
                # Native caption format retained with timestamps, never parsed into claimed speech.
                raw=body.decode('utf-8','replace');text=text_field(raw,chars);chars-=len(text)
                result['captions']['tracks'].append({'language':text_field(language,40),'source':kind,'format':track['ext'],'text':text,
                    'bytes':len(body),'truncated':truncated or len(raw)>len(text),'coverage':'bounded raw subtitle cues with source timestamps, not independently verified speech'})
                result['captions']['status']='available'
            except LimitError:raise
            except Exception:result['captions']['status']='fetch_unavailable'
    if not result['captions']['tracks'] and info.get('automatic_captions') and not bounds['autoCaptions']:
        result['captions']['status']='manual_unavailable_auto_disabled'
    return result

def overview(url,root,bounds,deadline):
    import yt_dlp
    from PIL import Image
    import io
    budget=Budget(min(bounds['bytes'],bounds['overviewBytes'] if 'overviewBytes' in bounds else bounds['bytes']))
    class DL(yt_dlp.YoutubeDL):
        def urlopen(self,request):return budget.wrap(super().urlopen(request))
    class Quiet:
        def debug(self,*args):pass
        def warning(self,*args):pass
        def error(self,*args):pass
    options={'quiet':True,'logger':Quiet(),'noplaylist':True,'socket_timeout':min(8,bounds['timeout']),'retries':0,'extractor_retries':0,'fragment_retries':0,'cachedir':False,'enable_file_urls':False,'usenetrc':False,'cookiefile':None,'cookiesfrombrowser':None,'plugin_dirs':[],'js_runtimes':{},'remote_components':set(),'skip_download':True}
    images=[];times=[];notes=[];processed=0
    with DL(options) as dl:
        info=dl.extract_info(url,download=False,process=False)
        if not info or info.get('_type') in ('playlist','multi_video','url','url_transparent') or info.get('is_live') or info.get('has_drm'):raise LimitError('overview_source_unsupported')
        meta=metadata(dl,info,bounds);duration=meta['duration']
        if duration is None or duration>bounds['duration']:raise LimitError('overview_duration_limit')
        count=min(bounds['count'],bounds['frames']);scene_count=min(2,max(1,count//2));preview_count=count-scene_count
        targets=[min(max(0,duration-1),duration*(i+.5)/max(1,preview_count)) for i in range(preview_count)]
        scan_seconds=min(bounds['scanSeconds'],int(duration))
        if scan_seconds<1:raise LimitError('overview_duration_limit')
        used=budget.used
        part=dict(bounds,seconds=scan_seconds,frames=scene_count,start=0,bytes=budget.maximum-used,processedCap=bounds['processedCap'],noWhole=False,noAudio=True,scene=True,timeout=max(3,int(deadline-time.monotonic())))
        with tempfile.TemporaryDirectory(dir=root) as child:
            data,transferred=download(url,child,part);used+=transferred
            frames,_=decode(data,child,part,deadline)
            images.extend(frames);times.extend(part['frameTimes']);processed+=part['processedSeconds']
        budget.used=used;sampled=part['sampledFrames'];scan_range=part['scanRange']
        notes.extend(part['coverageNotes'])
        storyboards=[f for f in info.get('formats',[]) if f.get('protocol')=='mhtml' and f.get('fragments') and 48<=f.get('width',0)<=bounds['resolution'] and 0<f.get('height',0)<=bounds['resolution']]
        storyboards.sort(key=lambda f:f['width'],reverse=True)
        if storyboards:
            fmt=storyboards[0];w,h,cols,rows=(fmt.get(k) for k in ('width','height','columns','rows'));fps=fmt.get('fps')
            if not all(type(x) is int and 0<x<=10000 for x in (w,h,cols,rows)) or not isinstance(fps,(int,float)) or not math.isfinite(fps) or fps<=0 or w*h*cols*rows>16777216:raise LimitError('invalid_storyboard')
            sheets={}
            for target in targets:
                index=int(target*fps);sheet_index=index//(cols*rows);cell=index%(cols*rows)
                if sheet_index>=len(fmt['fragments']) or index/fps>=duration:notes.append('storyboard sample unavailable');continue
                if sheet_index not in sheets:
                    body,_=capped_body(dl,fmt['fragments'][sheet_index]['url'],fmt.get('http_headers'),min(2097152,bounds['bytes']-budget.used))
                    picture=Image.open(io.BytesIO(body))
                    if picture.width*picture.height>16777216 or picture.size!=(w*cols,h*rows):raise LimitError('storyboard_pixel_limit')
                    picture.load();sheets[sheet_index]=picture
                tile=sheets[sheet_index].crop(((cell%cols)*w,(cell//cols)*h,(cell%cols+1)*w,(cell//cols+1)*h)).convert('RGB')
                tile.thumbnail((bounds['resolution'],bounds['resolution']))
                out=io.BytesIO();tile.save(out,format='JPEG',quality=75)
                data=out.getvalue()
                if len(data)>524288:raise LimitError('artifact_limit')
                images.append(base64.b64encode(data).decode());times.append(round(index/fps,3))
            mode='publisher-storyboard';notes.append('Times are nominal storyboard indices from yt-dlp fps, not decoded video PTS; sparse previews, not full watching.')
        else:
            # No full transfer fallback or audio extraction for overview. Bounded local ranged/segment seeks only.
            used=budget.used;mode='bounded-ranged-seeks';maximum=budget.maximum
            for target in targets:
                if used>=maximum or time.monotonic()>=deadline:raise LimitError('overview_budget')
                part=dict(bounds,seconds=1,frames=1,start=int(target),bytes=maximum-used,processedCap=bounds['processedCap']-processed,noWhole=True,noAudio=True,timeout=max(3,int(deadline-time.monotonic())))
                with tempfile.TemporaryDirectory(dir=root) as child:
                    data,transferred=download(url,child,part);used+=transferred
                    frames,_=decode(data,child,part,deadline);images.extend(frames[:1]);times.append(int(target));processed+=part['processedSeconds']
            budget.used=used
            notes.append('Times are requested bounded seek targets; sampled fps frame, not exact decoded PTS. No full decode or audio/STT.')
    sampled+=preview_count
    images,times,skipped=dedupe_frames(images,times,bounds['dedupeThreshold'])
    notes.append('Overview dedupe omitted times '+str(skipped)+'; spread previews may be nominal storyboard/seek timestamps.')
    if not images:raise LimitError('overview_no_frames')
    if processed>bounds['processedCap']:raise LimitError('processed_limit')
    return {'ok':True,'overview':True,'metadata':meta,'frames':images,'frameTimes':times,'audio':None,'seconds':bounds['seconds'],'start':bounds['start'],
        'transferBytes':budget.used,'processedSeconds':processed,'duration':duration,'downloadMode':'bounded-scene-overview','coverageNotes':notes[:8],'scanRange':scan_range,'sampledFrames':min(count,sampled)}
def plan_native(bounds,duration,source_identity):
    cfg=bounds.get('nativeConfig')
    if not cfg:return
    if type(duration) not in (int,float) or not math.isfinite(duration) or duration<=0 or duration>86400:raise LimitError('native_source_duration_unknown')
    explicit=cfg.get('explicitRange',False)
    mode='static' if duration<cfg['maxShort'] else 'agentic'
    maximum=cfg['maxShort'] if mode=='static' else cfg['maxLong']
    if not explicit:
        if duration>maximum:raise LimitError('native_agentic_full_source_exceeds_coverage_budget')
        bounds.update(start=0,seconds=duration)
    end=bounds['start']+bounds['seconds']
    if end>duration+0.05 or bounds['seconds']>maximum:raise LimitError('native_range_outside_source')
    # A duration spans two conservative processing passes, not sampled FPS seconds.
    TRACE.update(sourceDuration=duration,requestedCoverage=[bounds['start'],end],processedCap=bounds['processedCap'],minimumProcessedSeconds=2*bounds['seconds'])
    # Native source coverage is independently bounded; decoder-work seconds are NOT wall time.
    ranges=sorted(cfg['priorRanges']+[[bounds['start'],end]]);merged=[]
    for a,b in ranges:
        if merged and a<=merged[-1][1]:merged[-1][1]=max(merged[-1][1],b)
        else:merged.append([a,b])
    if sum(b-a for a,b in merged)>cfg['uniqueCap']:raise LimitError('native_unique_coverage_budget')
    bounds.update(duration=duration,nativeSourceDuration=duration,nativeSourceFingerprint=hashlib.sha256(json.dumps(source_identity,sort_keys=True).encode()).hexdigest(),
        nativeFull=not explicit,nativePlanned=True,nativeMode=mode)

def native_clip(data,root,bounds,deadline):
    local=isinstance(data,str)
    if local and (os.path.dirname(data)!=root or os.path.islink(data)):raise LimitError('invalid_decoder_input')
    source=data if local else 'pipe:0'; payload=b'' if local else data
    protocol='file' if local else 'pipe'
    probe=json.loads(command(['ffprobe','-v','error','-protocol_whitelist',protocol,
        '-format_whitelist','mov,matroska,mpegts,aac,avi,ogg,mp3,wav','-max_alloc','33554432',
        '-show_entries','stream=codec_type,width,height','-of','json',source],payload,deadline))
    videos=[v for v in probe.get('streams',[]) if v.get('codec_type')=='video']
    if not videos or any(not 0<v.get('width',0)*v.get('height',0)<=MAX_PIXELS for v in videos):raise LimitError('pixel_limit')
    cfg=bounds.get('nativeConfig',{'fps':1,'dimension':360,'version':'whole-short-v2'})
    seconds=bounds['seconds']; offset=bounds.get('offset',0)
    if bounds.get('nativeConfig') and not bounds.get('nativePlanned'):raise LimitError('native_source_duration_unknown')
    # Charge decoder/keyframe padding, not just requested duration.
    padding=0
    if local:
        packets=json.loads(command(['ffprobe','-v','quiet','-protocol_whitelist','file',
            '-format_whitelist','mov,matroska,mpegts,aac,avi,ogg,mp3,wav',
            '-read_intervals',str(offset)+'%+'+str(seconds),'-show_entries','packet=pts_time,codec_type','-of','json',source],
            b'',deadline,1048576)).get('packets',[])
        starts=[float(p['pts_time']) for p in packets if p.get('codec_type') in ('video','audio') and p.get('pts_time') is not None]
        if not starts or any(not math.isfinite(t) for t in starts):raise LimitError('seek_coverage_unavailable')
        padding=max(0,offset-min(starts))
    processed=max(bounds.get('processedSeconds',0),2*(seconds+padding))
    if processed>bounds['processedCap']:raise LimitError('processed_limit')
    cap=min(bounds['bytes'],8*1024*1024)
    args=['ffmpeg','-nostdin','-hide_banner','-v','error','-threads','1','-filter_threads','1',
        '-max_alloc','33554432','-protocol_whitelist',protocol,'-format_whitelist','mov,matroska,mpegts,aac,avi,ogg,mp3,wav']
    if local:args+=['-ss',str(offset)]
    args+=['-i',source]
    if not local:args+=['-ss',str(offset)]
    args+=['-t',str(seconds),'-map','0:v:0','-map','0:a:0?','-vf',
        'fps='+str(cfg['fps'])+',scale='+str(cfg['dimension'])+':'+str(cfg['dimension'])+':force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-c:v','libx264','-preset','ultrafast','-crf','30','-pix_fmt','yuv420p',
        '-c:a','aac','-ac','1','-ar','16000','-b:a','32k','-movflags','+faststart','-fs',str(cap),root+'/native.mp4']
    command(args,payload,deadline)
    raw=bounded_file(root,'native.mp4',cap)
    output=json.loads(command(['ffprobe','-v','error','-protocol_whitelist','file','-format_whitelist','mov',
        '-show_entries','format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames,duration','-of','json',root+'/native.mp4'],b'',deadline))
    duration=float(output.get('format',{}).get('duration','nan'))
    video=next((v for v in output.get('streams',[]) if v.get('codec_type')=='video'),{})
    try:
        numerator,denominator=map(float,video['avg_frame_rate'].split('/'));actual_fps=numerator/denominator
        frame_count=int(video['nb_frames']);vd=float(video['duration'])
    except (KeyError,ValueError,ZeroDivisionError):raise LimitError('native_encoding_unverified')
    expected=math.ceil(seconds*cfg['fps']-0.00001)
    # A 1 FPS final frame lasts up to one second past a fractional source end.
    # Require all expected frames and audio/container duration through the source end;
    # never accept -fs truncation or claim every original frame was inspected.
    if not math.isfinite(duration) or duration<seconds-0.15 or duration>seconds+1/cfg['fps']+0.15 or frame_count!=expected or abs(actual_fps-cfg['fps'])>0.0001 or abs(vd-frame_count/cfg['fps'])>0.15 or video.get('codec_name')!='h264' or max(video.get('width',0),video.get('height',0))>cfg['dimension']:
        raise LimitError('native_encoded_coverage_unverified')
    return {'ok':True,'clip':base64.b64encode(raw).decode(),'mime':'video/mp4','start':bounds['start'],
        'end':bounds['start']+seconds,'transferBytes':bounds.get('transferBytes',0),'processedSeconds':processed,
        'fingerprint':hashlib.sha256(raw).hexdigest(),'sourceFingerprint':bounds.get('nativeSourceFingerprint',hashlib.sha256(raw).hexdigest()),
        'sourceDuration':bounds.get('nativeSourceDuration',bounds.get('duration',bounds['start']+seconds)),'fullSource':bounds.get('nativeFull',False),'fps':actual_fps,
        'width':video['width'],'height':video['height'],'frameCount':frame_count,'encodedDuration':duration,
        'mode':bounds.get('nativeMode'),'codec':'h264','pipelineVersion':cfg['version'],'downloadMode':bounds.get('downloadMode')}

def native_metadata(url,bounds):
    import yt_dlp
    class Quiet:
        def debug(self,*args):pass
        def warning(self,*args):pass
        def error(self,*args):pass
    budget=Budget(min(bounds['bytes'],2*1024*1024))
    class DL(yt_dlp.YoutubeDL):
        def urlopen(self,req):return budget.wrap(super().urlopen(req))
    with DL({'skip_download':True,'noplaylist':True,'socket_timeout':8,'retries':0,'extractor_retries':0,'cachedir':False,'logger':Quiet(),'quiet':True,'cookiefile':None,'cookiesfrombrowser':None,'usenetrc':False,'enable_file_urls':False,'plugin_dirs':[],'js_runtimes':{},'remote_components':set()}) as dl:
        info=dl.extract_info(url,download=False,process=False)
    if not info or info.get('_type') in ('playlist','multi_video') or info.get('is_live') or info.get('has_drm'):raise LimitError('native_source_unsupported')
    d=info.get('duration')
    if type(d) not in (float,int) or not math.isfinite(d) or d<=0:raise LimitError('native_source_duration_unknown')
    return {'ok':True,'duration':d,'videoDownloadBytes':0,'provenance':'yt-dlp metadata only'}

def inspect(request, downloader=download, decoder=decode):
    bounds=limits(request); upload=request.get('upload'); url=None if upload is not None else public_url(request.get('url'))
    deadline=time.monotonic()+bounds['timeout']
    if request.get('nativeMetadata') is True:return native_metadata(url,bounds)
    with tempfile.TemporaryDirectory(prefix='kamakura-video-',dir='/tmp') as root:
        os.chmod(root,0o700)
        if bounds['overview'] and upload is None:return overview(url,root,bounds,deadline)
        data, transferred=uploaded_source(upload,root,bounds,deadline) if upload is not None else downloader(url,root,bounds)
        if (not isinstance(data,str) and len(data)>bounds['bytes']) or transferred>bounds['bytes']: raise LimitError('download_limit')
        if request.get('nativeClip') is True:
            bounds['transferBytes']=transferred
            return native_clip(data,root,bounds,deadline)
        TRACE['stage']='ffmpeg_decode'
        frames,audio=decoder(data,root,bounds,deadline)
        TRACE['stage']='complete'
        return {'ok':True,'frames':frames,'audio':audio,'seconds':bounds['seconds'],'transferBytes':transferred,'start':bounds['start'],'processedSeconds':bounds.get('processedSeconds',bounds['seconds']),'duration':bounds.get('duration'),'downloadMode':bounds.get('downloadMode'),'sourceFormat':bounds.get('sourceFormat'),'metadata':bounds.get('metadata'),'frameTimes':bounds.get('frameTimes',[bounds['start']+i*bounds['seconds']/max(1,len(frames)) for i in range(len(frames))]),'sampledFrames':bounds.get('sampledFrames',len(frames)),'coverageNotes':bounds.get('coverageNotes',[]),'scanRange':bounds.get('scanRange')}

def main():
    # Killable helper/children, no cached configs or environment credential inheritance.
    os.umask(0o077)
    request=json.loads(base64.b64decode(sys.argv[1],validate=True)); bounds=limits(request)
    for name in os.listdir('/tmp'):
        if re.fullmatch(r'kamakura-upload-[a-f0-9]{48}\.bin',name):
            try:
                path='/tmp/'+name
                if time.time()-os.lstat(path).st_mtime>1800:os.unlink(path)
            except FileNotFoundError:pass
    resource.setrlimit(resource.RLIMIT_FSIZE,(bounds['bytes'],bounds['bytes']))
    resource.setrlimit(resource.RLIMIT_CPU,(bounds['timeout']+1,bounds['timeout']+2))
    resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    def timeout(*_): raise LimitError('timeout')
    signal.signal(signal.SIGALRM,timeout);signal.alarm(bounds['timeout'])
    try: result=inspect(request)
    except BaseException as e:
        # No media URLs, local paths, credentials or library tracebacks cross to the model.
        result={'ok':False,'error':str(e) if isinstance(e,LimitError) else ('requested_format_unavailable' if 'Requested format is not available' in str(e) else 'extractor_webpage_response' if 'Unexpected response from webpage request' in str(e) else 'unavailable_or_blocked'),**TRACE}
    finally: signal.alarm(0)
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__': main()
