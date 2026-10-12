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
if __name__=='__main__':unittest.main()
