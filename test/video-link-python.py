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
if __name__=='__main__':unittest.main()
