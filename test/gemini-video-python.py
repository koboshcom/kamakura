import importlib.util,json,os,tempfile,time,subprocess,unittest,hashlib,base64
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('video','deploy/video-link.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Tests(unittest.TestCase):
 def fixture(self,root,seconds=8):
  p=root+'/input.mp4'
  subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',str(seconds),'-c:v','libx264','-threads','1','-c:a','aac','-y',p],check=True)
  return p
 def test_real_offline_encode_range_hash_and_no_extra_seconds(self):
  with tempfile.TemporaryDirectory() as root:
   p=self.fixture(root)
   b=v.limits({'seconds':5,'start':2});b['offset']=2
   r=v.native_clip(p,root,b,time.monotonic()+25)
   data=base64.b64decode(r['clip'])
   self.assertEqual(data[4:8],b'ftyp');self.assertEqual(r['fingerprint'],hashlib.sha256(data).hexdigest())
   self.assertEqual((r['start'],r['end']),(2,7));self.assertLessEqual(r['processedSeconds'],60)
   self.assertEqual(r['mime'],'video/mp4')
 def test_caps_duration_pixels_symlink(self):
  with tempfile.TemporaryDirectory() as root:
   p=self.fixture(root,1)
   with self.assertRaises(v.LimitError):v.native_clip(p,root,v.limits({'seconds':5}),time.monotonic()+25)
   with self.assertRaises(v.LimitError):v.native_clip(p,root,v.limits({'processedCap':1}),time.monotonic()+25)
   link=root+'/link';os.symlink(p,link)
   with self.assertRaises(v.LimitError):v.native_clip(link,root,v.limits({}),time.monotonic()+25)
 def test_cleanup_all_outcomes_and_no_source_network_fixture(self):
  roots=[]
  def download(_url,root,bounds):
   roots.append(root);return self.fixture(root),100
  with patch.object(v,'public_url',side_effect=lambda x:x):
   r=v.inspect({'url':'https://fixture.invalid/video','nativeClip':True},download)
   self.assertTrue(r['ok'])
   with patch.object(v,'native_clip',side_effect=v.LimitError('fixture')):
    with self.assertRaises(v.LimitError):v.inspect({'url':'https://fixture.invalid/video','nativeClip':True},download)
  self.assertTrue(all(not os.path.exists(p) for p in roots))
if __name__=='__main__':unittest.main()
