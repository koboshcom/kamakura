import base64,importlib.util,json,os,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('video_link','deploy/video-link.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Tests(unittest.TestCase):
 def test_public(self):
  with patch.object(v.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',80))]):
   with self.assertRaises(v.LimitError):v.public_url('https://example.com/v')
  for url in ['file:///etc/passwd','https://a:b@example.com','https://example.com:22','https://example.com/\nx']:
   with self.assertRaises((v.LimitError,ValueError)):v.public_url(url)
 def test_artifacts(self):
  with tempfile.TemporaryDirectory() as d:
   with open(d+'/x','wb') as f:f.write(b'good')
   self.assertEqual(v.bounded_file(d,'x',4),b'good')
   with self.assertRaises(v.LimitError):v.bounded_file(d,'x',3)
   os.symlink('/etc/passwd',d+'/link')
   with self.assertRaises(OSError):v.bounded_file(d,'link',100)
   os.link(d+'/x',d+'/hard')
   with self.assertRaises(v.LimitError):v.bounded_file(d,'hard',100)
   with self.assertRaises(v.LimitError):v.bounded_file(d,'../x',100)
 def test_budget(self):
  import io
  b=v.Budget(3);response=b.wrap(io.BytesIO(b'12345'))
  self.assertEqual(response.read(2),b'12')
  with self.assertRaises(v.LimitError):response.read(3)
 def test_cleanup_success_failure(self):
  roots=[]
  def dl(url,root,bounds):
   roots.append(root);return b'fixture',7
  def dec(*args):return ['test'],None
  with patch.object(v,'public_url',side_effect=lambda x:x):
   self.assertTrue(v.inspect({'url':'https://example.com'},dl,dec)['ok'])
   def fail(*args):raise v.LimitError('fixture_failure')
   with self.assertRaises(v.LimitError):v.inspect({'url':'https://example.com'},dl,fail)
  for root in roots:self.assertFalse(os.path.exists(root))
 def test_unknown_duration_oversize(self):
  with patch.object(v,'public_url',side_effect=lambda x:x):
   def dl(url,root,bounds):return b'x',bounds['bytes']+1
   with self.assertRaises(v.LimitError):v.inspect({'url':'https://example.com'},dl)
 def test_real_local_decoder(self):
  import subprocess,time
  with tempfile.TemporaryDirectory() as d:
   file=d+'/fixture.ts'
   subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc=size=64x64:rate=10','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','4','-threads','1','-c:v','mpeg2video','-c:a','mp2','-f','mpegts',file],check=True)
   with open(file,'rb') as f:data=f.read()
   result=v.decode(data,d,v.limits({'seconds':2,'frames':2}),time.monotonic()+15)
   self.assertLessEqual(len(result[0]),2);self.assertIsNotNone(result[1])
 def test_limits(self):
  for r in [{'seconds':0},{'frames':9},{'bytes':999999999},{'timeout':True}]:
   with self.assertRaises(v.LimitError):v.limits(r)

 def test_partial_hls_selects_only_requested_segments(self):
  manifest='#EXTM3U\n#EXT-X-TARGETDURATION:5\n'+''.join('#EXTINF:5,\nseg%d.ts\n'%n for n in range(100))+'#EXT-X-ENDLIST\n'
  b=v.limits({'seconds':5,'start':0,'processedCap':60})
  segments,offset,processed,total=v.selected_segments(manifest,'https://example.com/video.m3u8',b)
  self.assertEqual(segments,['https://example.com/seg0.ts']);self.assertEqual(offset,0);self.assertEqual(processed,10);self.assertEqual(total,500)
  b.update(start=60)
  self.assertEqual(v.selected_segments(manifest,'https://example.com/v.m3u8',b)[0],['https://example.com/seg12.ts'])
  b.update(start=3,seconds=5)
  result=v.selected_segments(manifest,'https://example.com/v.m3u8',b)
  self.assertEqual(len(result[0]),2);self.assertEqual(result[1],3);self.assertEqual(result[2],20)
  b.update(processedCap=19)
  with self.assertRaises(v.LimitError):v.selected_segments(manifest,'https://example.com/v.m3u8',b)
 def test_partial_fail_closed_no_full_fallback(self):
  for manifest in ['#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST', '#EXTM3U\n#EXTINF:5,\na.ts', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST']:
   with self.assertRaises(v.LimitError):v.selected_segments(manifest,'https://example.com/v.m3u8',v.limits({}))

 def test_real_download_selection_with_fake_extractor_no_whole_video(self):
  import io,yt_dlp
  requests=[]; extraction=[];manifest='#EXTM3U\n'+''.join('#EXTINF:5,\nseg%d.ts\n'%n for n in range(100))+'#EXT-X-ENDLIST\n'
  class FakeDL:
   def __init__(self,opts):pass
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def extract_info(self,url,download):
    extraction.append(download);return {'url':'https://example.com/v.m3u8','protocol':'m3u8_native'}
   def urlopen(self,req):
    requests.append(req.url)
    result=io.BytesIO(manifest.encode() if req.url.endswith('.m3u8') else b'segment')
    result.url=req.url;return result
  with patch.object(yt_dlp,'YoutubeDL',FakeDL),tempfile.TemporaryDirectory() as d:
   bounds=v.limits({})
   data,used=v.download('https://example.com/v',d,bounds)
   self.assertEqual(extraction,[False]);self.assertEqual(data,b'segment')
   self.assertEqual(requests,['https://example.com/v.m3u8','https://example.com/seg0.ts'])
   self.assertEqual(used,len(manifest.encode())+7);self.assertEqual(bounds['processedSeconds'],10)
   requests.clear();bounds=v.limits({'start':60,'seconds':1})
   v.download('https://example.com/v',d,bounds)
   self.assertEqual(requests[-1],'https://example.com/seg12.ts')
 def test_real_local_offset_decoder(self):
  import subprocess,time,wave,io
  with tempfile.TemporaryDirectory() as d:
   f=d+'/offset.ts'
   subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc=size=64x64:rate=10','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','10','-threads','1','-c:v','mpeg2video','-c:a','mp2','-f','mpegts',f],check=True)
   with open(f,'rb') as source:data=source.read()
   b=v.limits({'seconds':1,'frames':1});b['offset']=6
   images,audio=v.decode(data,d,b,time.monotonic()+15)
   self.assertEqual(len(images),1)
   with wave.open(io.BytesIO(base64.b64decode(audio))) as w:self.assertLessEqual(w.getnframes(),16000)

 def test_mp4_real_ranged_prefix_and_whole_fallback(self):
  import io,yt_dlp,subprocess,time
  class Response(io.BytesIO):
   def __init__(self,data,status=200,headers=None):super().__init__(data);self.status=status;self.headers=headers or {}
  for fast in [True,False]:
   with tempfile.TemporaryDirectory() as d:
    source=d+'/fixture.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-f','lavfi','-i','sine=frequency=200:sample_rate=48000','-t','30','-c:v','libx264','-threads','1','-g','25','-c:a','aac']+(['-movflags','+faststart'] if fast else [])+[source],check=True)
    with open(source,'rb') as f:data=f.read()
    requests=[]
    class FakeDL:
     def __init__(self,opts):self.opts=opts
     def __enter__(self):return self
     def __exit__(self,*a):pass
     def extract_info(self,*a,**kw):return {'url':'https://example.com/file.mp4','protocol':'https','ext':'mp4','duration':30}
     def urlopen(self,req):
      ranges=req.headers.get('Range');requests.append(ranges)
      a,b=map(int,ranges[6:].split('-'));b=min(b,len(data)-1)
      return Response(data[a:b+1],206,{'Content-Range':f'bytes {a}-{b}/{len(data)}'})
    with patch.object(yt_dlp,'YoutubeDL',FakeDL):
     b=v.limits({'start':0});path,used=v.download('https://example.com',d,b)
     frames,audio=v.decode(path,d,b,time.monotonic()+15)
     self.assertEqual(len(frames),2);self.assertTrue(audio)
     self.assertEqual(used,sum(min(262144,len(data)-int(r[6:].split('-')[0])) for r in requests))
     if fast:self.assertEqual(b['downloadMode'],'progressive-range-prefix');self.assertLess(used,len(data))
     else:self.assertEqual(b['downloadMode'],'whole-file-bandwidth-capped-fallback');self.assertEqual(used,len(data))
     import wave
     with wave.open(io.BytesIO(base64.b64decode(audio))) as w:self.assertLessEqual(w.getnframes(),80000)
     # Explicit seek uses local index, never sends whole audio to providers.
     for frame in os.listdir(d):
      if frame.startswith('frame-') or frame=='audio.wav':os.unlink(d+'/'+frame)
     b=v.limits({'start':10});path,used=v.download('https://example.com',d,b)
     frames,audio=v.decode(path,d,b,time.monotonic()+15)
     self.assertEqual(len(frames),2)
 def test_no_range_whole_fallback_strict_body_cap(self):
  import io,yt_dlp
  class FakeDL:
   def __init__(self,opts):pass
   def __enter__(self):return self
   def __exit__(self,*a):pass
   def extract_info(self,*a,**k):return {'url':'https://example.com/file.webm','protocol':'https','ext':'webm','duration':30}
   def urlopen(self,req):return io.BytesIO(b'x'*100)
  with patch.object(yt_dlp,'YoutubeDL',FakeDL),tempfile.TemporaryDirectory() as d:
   b=v.limits({'bytes':30})
   with self.assertRaisesRegex(v.LimitError,'transfer_limit'):v.download('https://example.com',d,b)
   self.assertEqual(v.TRACE['transferBytes'],30)
   self.assertFalse(os.path.exists(d+'/whole-source.bin'))
   b=v.limits({'bytes':101});path,used=v.download('https://example.com',d,b)
   self.assertEqual(used,100);self.assertEqual(b['downloadMode'],'whole-file-bandwidth-capped-fallback')
 def test_live_and_drm_denied_before_download(self):
  import yt_dlp
  for info in [{'is_live':True},{'live_status':'is_upcoming'},{'has_drm':True},{'_type':'playlist'}]:
   class FakeDL:
    def __init__(self,opts):pass
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def extract_info(self,*a,**k):return info
    def urlopen(self,*a):self.fail('no media request allowed')
   with patch.object(yt_dlp,'YoutubeDL',FakeDL),tempfile.TemporaryDirectory() as d:
    with self.assertRaises(v.LimitError):v.download('https://example.com',d,v.limits({}))
 def test_dash_timeline_target_and_processed_cap(self):
  info={'fragments':[{'url':'https://example.com/init.mp4'}]+[{'url':'https://example.com/seg%d.m4s'%n,'duration':2} for n in range(20)]}
  b=v.limits({'start':10,'seconds':5})
  fragments,offset,processed,duration=v.dash_fragment_selection(info,b)
  self.assertEqual([f['url'] for f in fragments],['https://example.com/init.mp4','https://example.com/seg5.m4s','https://example.com/seg6.m4s','https://example.com/seg7.m4s'])
  self.assertEqual(offset,0);self.assertEqual(processed,6);self.assertEqual(duration,40)
  with self.assertRaises(v.LimitError):v.dash_fragment_selection({'fragments':[{'url':'https://example.com/unknown'}]},b)
 def test_dash_real_selected_fmp4_decode(self):
  import subprocess,glob,io,yt_dlp,time
  with tempfile.TemporaryDirectory() as d:
   subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10','-t','20','-threads','1','-c:v','libx264','-g','20','-keyint_min','20','-sc_threshold','0','-f','dash','-seg_duration','2',d+'/source.mpd'],check=True)
   files=sorted(glob.glob(d+'/chunk-stream0-*.m4s'));init=d+'/init-stream0.m4s'
   fragments=[{'url':'https://example.com/'+os.path.basename(init)}]+[{'url':'https://example.com/'+os.path.basename(f),'duration':2} for f in files]
   calls=[]
   class FakeDL:
    def __init__(self,opts):pass
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def extract_info(self,*a,**k):return {'url':'https://example.com/source.mpd','protocol':'http_dash_segments','ext':'mp4','duration':20,'fragments':fragments}
    def urlopen(self,req):
     name=req.url.rsplit('/',1)[-1];calls.append(name)
     with open(d+'/'+name,'rb') as f:return io.BytesIO(f.read())
   with patch.object(yt_dlp,'YoutubeDL',FakeDL):
    b=v.limits({'start':4,'seconds':5});path,used=v.download('https://example.com',d,b)
    frames,audio=v.decode(path,d,b,time.monotonic()+15)
    self.assertEqual(len(frames),2);self.assertIsNone(audio)
    self.assertEqual(b['downloadMode'],'dash-selected-fragments')
    self.assertEqual(len(calls),4);self.assertNotIn(os.path.basename(files[0]),calls)
    self.assertEqual(used,sum(os.path.getsize(d+'/'+f) for f in calls))
 def test_process_monitor_timeout_cleanup(self):
  import time
  with self.assertRaisesRegex(v.LimitError,'timeout'):
   v.command(['python3','-c','import time;time.sleep(3)'],b'',time.monotonic()+.05)
  with self.assertRaisesRegex(v.LimitError,'decoder_output_limit'):
   v.command(['python3','-c','import sys;sys.stdout.write("x"*10000)'],b'',time.monotonic()+3,20)

 def test_separate_hls_odd_dimensions_accurate_interval(self):
  import subprocess,io,yt_dlp,time
  with tempfile.TemporaryDirectory() as d:
   subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc=size=81x144:rate=10','-t','10','-threads','1','-c:v','libvpx-vp9','-g','20','-f','dash','-seg_duration','2',d+'/video.mpd'],check=True)
   import glob
   chunks=sorted(glob.glob(d+'/chunk-stream0-*'))
   init=os.path.basename(glob.glob(d+'/init-stream0.*')[0])
   manifest='#EXTM3U\n#EXT-X-MAP:URI="'+init+'"\n'+''.join('#EXTINF:2,\n'+os.path.basename(f)+'\n' for f in chunks)+'#EXT-X-ENDLIST\n'
   class FakeDL:
    def __init__(self,opts):pass
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def extract_info(self,*a,**k):return {'protocol':'m3u8_native+m3u8_native','ext':'mp4','requested_formats':[{'protocol':'m3u8_native','url':'https://example.com/a.m3u8'}]}
    def urlopen(self,req):
     name=req.url.rsplit('/',1)[-1]
     if name=='a.m3u8':body=manifest.encode()
     else:
      with open(d+'/'+name,'rb') as f:body=f.read()
     response=io.BytesIO(body);response.url=req.url;return response
   with patch.object(yt_dlp,'YoutubeDL',FakeDL):
    b=v.limits({'start':3,'seconds':5});path,used=v.download('https://example.com',d,b)
    frames,audio=v.decode(path,d,b,time.monotonic()+15)
    self.assertEqual(len(frames),2);self.assertEqual(b['offset'],0)
if __name__=='__main__':unittest.main()
