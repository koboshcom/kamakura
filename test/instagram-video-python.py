import importlib.util,json,os,tempfile,time,subprocess,unittest,types,sys
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('video','deploy/video-link.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Tests(unittest.TestCase):
 def setUp(self):v.TRACE.clear();v.TRACE.update(stage='validate',transferBytes=0)
 def fixture(self,root,seconds=3):
  path=root+'/fixture.mp4'
  subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',str(seconds),'-c:v','libx264','-threads','1','-c:a','aac','-y',path],check=True)
  return path
 def bounds(self,native=True):
  return v.limits(dict(seconds=2,nativeClip=native,nativeConfig=dict(maxShort=300,maxLong=1800,fps=1,dimension=360,explicitRange=False,version='whole-short-v2',uniqueCap=1800)) if native else dict(seconds=2))
 def test_canonical_strict_tracking(self):
  for kind in ['p','reel']:
   self.assertEqual(v.canonical_instagram('https://instagram.com/'+kind+'/Ab_c-D123?rpxt=secret&vrfl=secret#secret'),'https://www.instagram.com/'+kind+'/Ab_c-D123/')
  for path in ['/p/%61bc/','/p/x/../abc/','/p/abc/extra','/reels/abc','/redirect?q=x']:
   with self.assertRaises(v.LimitError):v.canonical_instagram('https://instagram.com'+path)
  for url in ['https://user:pass@instagram.com/p/abc/','https://instagram.com:444/p/abc/','https://instagram.com\\evil/p/abc/']:
   with self.assertRaises(v.LimitError):v.canonical_instagram(url)
  self.assertFalse(v.instagram_url('https://instagram.com.evil/p/abc/'))
 def test_categories_full_late_reason_secrets_redacted(self):
  for msg,code in [('There is no video in this post','instagram_nonvideo_post_unsupported'),('HTTP Error 429 Too many requests','instagram_rate_limited'),('Login required','instagram_auth_required'),('empty media response','instagram_empty_media_response'),('HTTP Error 403','instagram_http_forbidden')]:
   self.assertEqual(v.instagram_failure(msg)[0],code)
  text='prefix '+'.'*650+' late actual root reason https://user:pass@host/path?sessionid=SECRET @private_name Cookie=SECRET sessionid=SECRET Authorization=SECRET Bearer SECRET'
  result=v.instagram_safe_error(text);self.assertIn('late actual root reason',result)
  for secret in ['SECRET','private_name','user:pass','host/path']:self.assertNotIn(secret,result)
  self.assertIn('late root',v.instagram_safe_error('x'*9000+' late root'))
 def test_logger_bounded_no_raw_cookies_urls(self):
  logger=v.instagram_logger()
  for _ in range(40):logger.warning('Cookie=SECRET https://host/private @username')
  self.assertEqual(len(v.TRACE['diagnostics']),16);self.assertNotIn('SECRET',json.dumps(v.TRACE))
 def test_public_opts_off_no_cookie_sources_no_retries_canonical_args(self):
  recorded={}
  class DL:
   def __init__(self,opts):recorded['opts']=opts
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def extract_info(self,url,download=False):
    recorded['url']=url
    raise RuntimeError('There is no video in this post')
  fake=types.ModuleType('yt_dlp');fake.YoutubeDL=DL
  networking=types.ModuleType('yt_dlp.networking');networking.Request=object
  with patch.dict(sys.modules,{'yt_dlp':fake,'yt_dlp.networking':networking}),tempfile.TemporaryDirectory() as root:
   with self.assertRaisesRegex(v.LimitError,'instagram_nonvideo_post_unsupported'):
    v.download('https://www.instagram.com/p/abc/?rpxt=secret',root,self.bounds())
  self.assertEqual(recorded['url'],'https://www.instagram.com/p/abc/')
  opts=recorded['opts']
  for key in ['cookiefile','cookiesfrombrowser']:self.assertIsNone(opts[key])
  for key in ['retries','fragment_retries','extractor_retries']:self.assertEqual(opts[key],0)
  self.assertTrue(opts['noplaylist']);self.assertFalse(opts['usenetrc'])
 def test_local_duration_and_native_whole_clip_single_transfer(self):
  with tempfile.TemporaryDirectory() as root:
   source=self.fixture(root);body=Path(source).read_bytes();bounds=self.bounds()
   info={'protocol':'https','url':'https://cdn.example/source','duration':None}
   with patch.object(v,'read_body',return_value=(body,200,{})) as read:
    path=v.instagram_local_source(object(),info,root,bounds,time.monotonic()+15)
   self.assertEqual(read.call_count,1);self.assertAlmostEqual(info['duration'],3,delta=.1)
   v.plan_native(bounds,info['duration'],['fixture'])
   result=v.native_clip(path,root,bounds,time.monotonic()+15)
   self.assertTrue(result['fullSource']);self.assertEqual(result['frameCount'],3)
   self.assertEqual(result['downloadMode'],'instagram-bounded-whole-local-duration')
 def test_separate_progressive_streams_verified_once(self):
  with tempfile.TemporaryDirectory() as root:
   source=self.fixture(root);video=root+'/v.mp4';audio=root+'/a.m4a'
   subprocess.run(['ffmpeg','-nostdin','-v','error','-i',source,'-map','0:v','-c','copy',video],check=True)
   subprocess.run(['ffmpeg','-nostdin','-v','error','-i',source,'-map','0:a','-c','copy',audio],check=True)
   streams=[Path(video).read_bytes(),Path(audio).read_bytes()]
   with patch.object(v,'read_body',side_effect=[(b,200,{}) for b in streams]) as read:
    info={'requested_formats':[{'protocol':'https','url':'https://cdn.example/video'},{'protocol':'https','url':'https://cdn.example/audio'}]}
    v.instagram_local_source(object(),info,root,self.bounds(),time.monotonic()+15)
   self.assertEqual(read.call_count,2);self.assertAlmostEqual(info['duration'],3,delta=.1)
 def test_unsafe_protocol_drm_fragments_rejected_without_transfer(self):
  for fmt in [{'protocol':'file'},{'protocol':'https','has_drm':True},{'protocol':'https','fragments':[{}]}]:
   with tempfile.TemporaryDirectory() as root,patch.object(v,'read_body') as read:
    with self.assertRaisesRegex(v.LimitError,'instagram_unknown_duration_protocol_unsupported'):
     v.instagram_local_source(object(),fmt,root,self.bounds(),time.monotonic()+15)
    read.assert_not_called()
 def test_transfer_failure_cleanup_no_auth_retry(self):
  roots=[]
  def downloader(url,root,b):
   roots.append(root)
   with patch.object(v,'read_body',side_effect=v.LimitError('transfer_limit')) as read:
    v.instagram_local_source(object(),{'protocol':'https','url':'https://cdn.example/source'},root,b,time.monotonic()+15)
  with patch.object(v,'public_url',side_effect=lambda x:x):
   with self.assertRaisesRegex(v.LimitError,'transfer_limit'):
    v.inspect({'url':'https://instagram.com/reel/abc/','nativeClip':True},downloader)
  self.assertTrue(roots);self.assertTrue(all(not os.path.exists(p) for p in roots))
 def test_overview_fallback_is_opening_only_and_not_audio(self):
  def downloader(url,root,b):b.update(duration=18.8,downloadMode='instagram-bounded-whole-local-duration');return b'fixture',10
  def decoder(data,root,b,deadline):self.assertTrue(b['noAudio']);return ['fixture'],None
  with patch.object(v,'public_url',side_effect=lambda x:x):
   result=v.inspect({'url':'https://instagram.com/reel/abc/','overview':True},downloader,decoder)
  self.assertIn('not a whole-video overview',result['coverageNotes'][0]);self.assertEqual(result['seconds'],5)
if __name__=='__main__':unittest.main()
