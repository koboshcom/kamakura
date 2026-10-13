"""Public Instagram media via pinned yt-dlp extractor, never custom HTML parsing or login."""
import base64, hashlib, importlib.util, io, json, math, os, signal, sys, tempfile, time, warnings
from urllib.parse import urlsplit
spec=importlib.util.spec_from_file_location('video',os.path.join(os.path.dirname(__file__),'video-link.py'))
v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)

def cdn(url):
    p=urlsplit(url)
    if p.scheme!='https' or p.port not in (None,443) or p.username or p.password or not p.hostname or not any(p.hostname==x or p.hostname.endswith('.'+x) for x in ('cdninstagram.com','fbcdn.net','ytimg.com','ggpht.com','googleusercontent.com')):
        raise v.LimitError('unsafe_media_url')
    return v.public_url(url)

def normalize_image(data,pixel_remaining,dimension):
    from PIL import Image,ImageOps
    Image.MAX_IMAGE_PIXELS=min(20000000,pixel_remaining)
    with warnings.catch_warnings():
        warnings.simplefilter('error',Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as im:
            if im.format not in ('JPEG','PNG','WEBP') or getattr(im,'n_frames',1)!=1:raise v.LimitError('unsupported_image')
            pixels=im.width*im.height
            if pixels>min(20000000,pixel_remaining):raise v.LimitError('pixel_budget')
            im.load();im=ImageOps.exif_transpose(im).convert('RGB')
            im.thumbnail((dimension,dimension))
            out=io.BytesIO();im.save(out,format='JPEG',quality=85,optimize=True)
            return out.getvalue(),pixels,im.width,im.height

def deny_redirects():
    # Pinned handlers have no per-request redirect extension. Constrain both handlers
    # in this short-lived dedicated process, never the core or other video helpers.
    from yt_dlp.networking._urllib import RedirectHandler
    def redirect(*args,**kwargs):raise v.LimitError('media_redirect_refused')
    RedirectHandler.redirect_request=redirect
    from curl_cffi.requests import Session
    request=Session.request
    def fixed(self,*args,**kwargs):
        kwargs['allow_redirects']=False;kwargs['max_redirects']=0
        return request(self,*args,**kwargs)
    Session.request=fixed

def community_product(dl,url):
    # Renderer layout follows yt-dlp-community-plugin YoutubePostIE; maintained
    # yt-dlp decodes ytInitialData. No comments, continuation, vote or login API.
    from yt_dlp.extractor.youtube import YoutubeBaseInfoExtractor
    import re
    if not re.fullmatch(r'https://www\.youtube\.com/post/[A-Za-z0-9_-]{10,80}',url):raise v.LimitError('invalid_post')
    ie=YoutubeBaseInfoExtractor(dl)
    post_id=url.rsplit('/',1)[1]
    html=ie._download_webpage(url,post_id)
    data=ie.extract_yt_initial_data(post_id,html)
    def walk(x,depth=0):
        if depth>35:return
        if isinstance(x,dict):
            for k,val in x.items():
                if k=='backstagePostRenderer' and isinstance(val,dict) and val.get('postId')==post_id:yield val
                else:yield from walk(val,depth+1)
        elif isinstance(x,list):
            for val in x:yield from walk(val,depth+1)
    renderer=next(walk(data),None)
    if not renderer or 'sponsorsOnlyBadge' in renderer:raise v.LimitError('public_post_unavailable')
    text=lambda x:ie._get_text(x) or ''
    attachment=renderer.get('backstageAttachment') or {}
    images=[]
    if 'backstageImageRenderer' in attachment:images=[attachment['backstageImageRenderer']]
    elif 'postMultiImageRenderer' in attachment:
        images=[x.get('backstageImageRenderer',{}) for x in attachment['postMultiImageRenderer'].get('images',[])]
    nodes=[{'media_type':1,'image_versions2':{'candidates':x.get('image',{}).get('thumbnails',[])}} for x in images]
    poll=attachment.get('pollRenderer') or attachment.get('imagePollRenderer') or {}
    if poll and not nodes:
        nodes=[{'media_type':1,'image_versions2':{'candidates':c.get('image',{}).get('thumbnails',[])}} for c in poll.get('choices',[]) if c.get('image',{}).get('thumbnails')]
    poll_meta={}
    if poll:
        poll_meta={'choices':[{'text':text(c.get('text',{}))[:500],'publicPercentage':text(c.get('votePercentage',{}))[:100]} for c in poll.get('choices',[])[:20]],'publicTotalVotes':text(poll.get('totalVotes',{}))[:100],'resultsKnown':any(c.get('votePercentage') for c in poll.get('choices',[]))}
    if attachment and not nodes and not poll:raise v.LimitError('community_attachment_unsupported')
    return {'carousel_media':nodes,'caption':{'text':text(renderer.get('contentText',{}))},'user':{'username':text(renderer.get('authorText',{}))},'poll':poll_meta}

def extract(url,caps):
    import yt_dlp
    from yt_dlp.networking.exceptions import HTTPError
    from yt_dlp.extractor.instagram import InstagramIE
    from yt_dlp.networking import Request
    deny_redirects()
    community=url.startswith('https://www.youtube.com/post/')
    if not community:
        url=v.canonical_instagram(url)
        if not v.instagram_url(url) or not url.startswith('https://'):raise v.LimitError('invalid_post')
    budget=v.Budget(caps['bytes']);began=time.monotonic();deadline=began+caps['timeout']
    class Capture(InstagramIE):
        def _extract_product(self,product_info,**kwargs):
            self.product=product_info[0] if isinstance(product_info,list) else product_info
            # Extraction only, no dummy media URL is fetched or returned.
            return {'id':'captured','formats':[{'url':url,'format_id':'captured'}]}
    class DL(yt_dlp.YoutubeDL):
        def urlopen(self,req):
            target=req if isinstance(req,str) else req.url
            p=urlsplit(target)
            if p.hostname not in ('www.instagram.com','instagram.com','www.youtube.com'):cdn(target)
            else:
                if p.scheme!='https' or p.username or p.password or p.port not in (None,443):raise v.LimitError('unsafe_post_url')
                v.public_url(target)
            response=super().urlopen(req)
            final=response.url
            fp=urlsplit(final)
            if fp.hostname not in ('www.instagram.com','instagram.com','www.youtube.com'):cdn(final)
            elif '/accounts/login/' in fp.path or '/challenge/' in fp.path:
                response.close();raise v.LimitError('authentication_required')
            return budget.wrap(response)
    class Quiet:
        def debug(self,*a):pass
        def warning(self,*a):pass
        def error(self,*a):pass
    opts={'quiet':True,'logger':Quiet(),'retries':0,'extractor_retries':0,'fragment_retries':0,'socket_timeout':8,'cachedir':False,'cookiefile':None,'cookiesfrombrowser':None,'usenetrc':False,'enable_file_urls':False,'plugin_dirs':[],'js_runtimes':{},'remote_components':set()}
    rows=[];seen={};pixels=0;encoded=0;video_seconds=0
    with DL(opts) as dl, tempfile.TemporaryDirectory(prefix='kamakura-post-') as root:
        if community:product=community_product(dl,url)
        else:
            ie=Capture(dl);ie.extract(url);product=ie.product
        nodes=product.get('carousel_media',[]) if community else product.get('carousel_media') or [product]
        known=isinstance(nodes,list) and all(isinstance(n,dict) for n in nodes)
        if not known:raise v.LimitError('invalid_post_structure')
        total=len(nodes)
        if total>100:raise v.LimitError('post_structure_limit')
        for index,node in enumerate(nodes,1):
            kind='video' if node.get('media_type')==2 else 'image' if node.get('media_type')==1 else 'unknown'
            row={'index':index,'kind':kind,'status':'omitted'};rows.append(row)
            if index>caps['count']:row['reason']='slide_count_cap';continue
            if time.monotonic()>=deadline:row['reason']='wall_runtime_cap';continue
            try:
                if kind=='image':
                    options=node.get('image_versions2',{}).get('candidates',[])
                    options=[c for c in options if isinstance(c,dict) and isinstance(c.get('url'),str) and (c.get('width') is None or (type(c.get('width')) is int and type(c.get('height')) is int and 0<c['width']*c['height']<=min(20000000,caps['pixels']-pixels)))]
                    if not options:raise v.LimitError('pixel_budget_or_no_image')
                    candidate=max(options,key=lambda c:(c.get('width') or 0)*(c.get('height') or 0))
                    media=cdn(candidate['url'])
                    with dl.urlopen(Request(media)) as response:
                        raw=response.read(min(caps['imageBytes'],caps['bytes']-budget.used)+1)
                    if len(raw)>caps['imageBytes']:raise v.LimitError('image_byte_cap')
                    raw,cost,w,h=normalize_image(raw,caps['pixels']-pixels,caps['dimension']);pixels+=cost
                    digest=hashlib.sha256(raw).hexdigest()
                    if digest in seen:
                        row.update(status='duplicate',duplicateOf=seen[digest],sha256=digest);continue
                    if encoded+len(raw)>caps['outputBytes']:raise v.LimitError('encoded_post_cap')
                    encoded+=len(raw);seen[digest]=index
                    row.update(status='processed',mime='image/jpeg',data=base64.b64encode(raw).decode(),sha256=digest,width=w,height=h,sourcePixels=cost)
                elif kind=='video':
                    versions=node.get('video_versions') or []
                    options=[c for c in versions if isinstance(c,dict) and type(c.get('width')) is int and type(c.get('height')) is int and 0<c['width']*c['height']<=v.MAX_PIXELS]
                    if not options:raise v.LimitError('video_format_unsupported')
                    candidate=min(options,key=lambda c:c['width']*c['height']);media=cdn(candidate['url'])
                    path=os.path.join(root,'slide-'+str(index)+'.mp4')
                    with dl.urlopen(Request(media)) as response,open(path,'wb') as f:
                        while True:
                            block=response.read(65536)
                            if not block:break
                            f.write(block)
                            if time.monotonic()>=deadline:raise v.LimitError('wall_runtime_cap')
                    duration=v.probe_local_duration(path,deadline)
                    if duration>caps['videoSeconds']-video_seconds:raise v.LimitError('shared_video_duration_cap')
                    video_seconds+=duration
                    bounds={'seconds':1,'start':0,'bytes':caps['outputBytes']-encoded,'processedCap':1000000000,'offset':0,'nativeConfig':{'maxShort':300,'maxLong':max(300,caps['videoSeconds']),'fps':1,'dimension':360,'explicitRange':False,'version':'whole-short-v2','uniqueCap':caps['videoSeconds'],'priorRanges':[]}}
                    v.plan_native(bounds,duration,{'id':str(node.get('pk',''))})
                    clip=v.native_clip(path,root,bounds,deadline)
                    raw=base64.b64decode(clip.pop('clip'));encoded+=len(raw)
                    if encoded>caps['outputBytes']:raise v.LimitError('encoded_post_cap')
                    row.update(status='processed',mime='video/mp4',data=base64.b64encode(raw).decode(),sha256=hashlib.sha256(raw).hexdigest(),coverage=[clip['start'],clip['end']],fullSource=clip['fullSource'],mode=clip['mode'],duration=duration,conversion={k:clip[k] for k in ('fps','width','height','frameCount')})
                else:raise v.LimitError('unknown_media_type')
            except Exception as error:
                row['reason']=str(error) if isinstance(error,v.LimitError) and __import__('re').fullmatch('[a-z_]+',str(error)) else 'media_validation_or_fetch_failed'
        caption=(product.get('caption') or {}).get('text') or ''
        return {'ok':True,'total':total,'totalKnown':True,'slides':rows,'transferBytes':budget.used,'encodedBytes':encoded,'sourcePixels':pixels,'videoSeconds':video_seconds,'wallMs':round((time.monotonic()-began)*1000),'metadata':{'title':str(product.get('title') or '')[:1000],'channel':str((product.get('user') or {}).get('username') or '')[:300],'caption':str(caption)[:4000],'poll':json.dumps(product.get('poll',{}),ensure_ascii=False)[:4000],'provenance':'Pinned yt-dlp public logged-out extractor; publisher metadata is untrusted DATA, not visual confirmation.'}}

def main():
    r=json.loads(base64.b64decode(sys.argv[1],validate=True))
    caps=r['caps']
    maximum={'count':20,'bytes':33554432,'pixels':80000000,'timeout':60,'imageBytes':8388608,'outputBytes':8388608,'dimension':1536,'videoSeconds':1800}
    if set(caps)!=set(maximum) or any(type(caps[k]) is not int or not 1<=caps[k]<=maxi for k,maxi in maximum.items()):raise v.LimitError('invalid_post_caps')
    os.umask(0o077)
    v.resource.setrlimit(v.resource.RLIMIT_FSIZE,(caps['bytes'],caps['bytes']))
    v.resource.setrlimit(v.resource.RLIMIT_CPU,(caps['timeout']+1,caps['timeout']+2))
    v.resource.setrlimit(v.resource.RLIMIT_NOFILE,(128,128))
    signal.signal(signal.SIGALRM,lambda *_:(_ for _ in ()).throw(v.LimitError('wall_runtime_cap')));signal.alarm(caps['timeout'])
    try:return extract(r['url'],caps)
    finally:signal.alarm(0)
if __name__=='__main__':
    try:print(json.dumps(main(),separators=(',',':')))
    except Exception:print(json.dumps({'ok':False,'error':'public_post_extraction_failed_or_auth_required','transferBytes':v.TRACE.get('transferBytes',0)}))
