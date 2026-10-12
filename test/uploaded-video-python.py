import base64,hashlib,importlib.util,json,os,tempfile,time,unittest,subprocess,uuid,wave,io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('video_link','deploy/video-link.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Tests(unittest.TestCase):
 def setUp(self):
  self.id=(uuid.uuid4().hex+uuid.uuid4().hex)[:48];self.path='/tmp/kamakura-upload-'+self.id+'.bin'
  subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc=size=64x64:rate=10','-f','lavfi','-i','sine=frequency=300:sample_rate=16000','-t','12','-threads','1','-c:v','libx264','-g','10','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',self.path],check=True)
  with open(self.path,'rb') as f:data=f.read()
  self.upload={'id':self.id,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
 def tearDown(self):
  if os.path.lexists(self.path):os.unlink(self.path)
 def test_first_next_timestamp_real_fixture(self):
  with patch.object(v,'public_url',side_effect=AssertionError('no URL fetch')),patch.object(v,'download',side_effect=AssertionError('no downloader')):
   for start,seconds,frames in [(0,5,2),(5,5,2),(10,1,1)]:
    result=v.inspect({'upload':self.upload,'start':start,'seconds':seconds,'frames':frames})
    self.assertEqual(result['downloadMode'],'local-upload');self.assertEqual(result['transferBytes'],0)
    self.assertEqual(result['start'],start);self.assertEqual(len(result['frames']),frames)
    self.assertLessEqual(result['processedSeconds'],60);self.assertGreater(result['duration'],11)
    with wave.open(io.BytesIO(base64.b64decode(result['audio']))) as w:self.assertLessEqual(w.getnframes(),seconds*16000)
 def test_integrity_links_paths_actual_size(self):
  for fields in [{'sha256':'0'*64},{'bytes':1},{'bytes':v.MAX_BYTES+1},{'id':'../../etc/passwd'},{'id':'z'*48}]:
   with self.assertRaises((v.LimitError,OSError)):v.inspect({'upload':{**self.upload,**fields}})
  os.unlink(self.path);os.symlink('/etc/passwd',self.path)
  with self.assertRaises(OSError):v.inspect({'upload':self.upload})
 def test_hardlink_and_duration_processed_limits(self):
  with tempfile.TemporaryDirectory() as d:
   os.link(self.path,d+'/link')
   with self.assertRaises(v.LimitError):v.inspect({'upload':self.upload})
  with self.assertRaises(v.LimitError):v.inspect({'upload':self.upload,'start':13})
  with self.assertRaises(v.LimitError):v.inspect({'upload':self.upload,'processedCap':5})
 def test_cleanup_snapshot_on_failure(self):
  roots=[]
  def fail(data,root,*args):roots.append(root);raise v.LimitError('fixture')
  with self.assertRaises(v.LimitError):v.inspect({'upload':self.upload},decoder=fail)
  self.assertTrue(roots);self.assertTrue(all(not os.path.exists(root) for root in roots))
if __name__=='__main__':unittest.main()
