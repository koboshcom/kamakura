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

 def native_bounds(self,seconds=1,explicit=False,fps=1,dimension=360):
  return v.limits({'seconds':seconds,'nativeClip':True,'nativeConfig':{'maxShort':300,'fps':fps,'dimension':dimension,'explicitRange':explicit,'version':'whole-short-v2'}})
 def test_whole_eleven_seconds_actual_h264_fps_frames_res_and_coverage(self):
  with tempfile.TemporaryDirectory() as root:
   source=self.fixture(root,11);b=self.native_bounds()
   v.plan_native(b,11,['fixture',11])
   r=v.native_clip(source,root,b,time.monotonic()+25)
   self.assertEqual((r['start'],r['end']),(0,11));self.assertTrue(r['fullSource'])
   self.assertEqual(r['fps'],1);self.assertEqual(r['frameCount'],11);self.assertLessEqual(max(r['width'],r['height']),360);self.assertEqual(r['codec'],'h264')
   self.assertGreaterEqual(r['processedSeconds'],22);self.assertLess(r['processedSeconds'],23)
 def test_full_native_source_300_not_decoded_work60_and_nonnative_unchanged(self):
  for duration in [31,97,300]:
   b=self.native_bounds();b['nativeConfig']['uniqueCap']=300;b['processedCap']=1000000000
   v.plan_native(b,duration,['fixture']);self.assertEqual(b['seconds'],duration)
  with self.assertRaisesRegex(v.LimitError,'native_agentic_full_source_exceeds_coverage_budget'):v.plan_native(self.native_bounds(),301,['fixture'])
  self.assertEqual(v.limits({})['processedCap'],60)
  for duration,mode in [(299.999,'static'),(300,'agentic')]:
   b=self.native_bounds();b['nativeConfig']['uniqueCap']=300;v.plan_native(b,duration,['fixture']);self.assertEqual(b['nativeMode'],mode)
  b=self.native_bounds(5,True);v.plan_native(b,900,['fixture']);self.assertEqual(b['nativeMode'],'agentic')
 def test_unique_coverage_and_quality_upgrade_share_boundaries(self):
  b=self.native_bounds();b['nativeConfig']['priorRanges']=[[20,30]]
  with self.assertRaisesRegex(v.LimitError,'native_unique_coverage_budget'):v.plan_native(b,11,['fixture'])
  b=self.native_bounds();b['nativeConfig']['priorRanges']=[[0,11]]
  v.plan_native(b,11,['fixture']);self.assertEqual(b['seconds'],11)
 def test_long_source_explicit_local_segment_and_unknown_or_outside_bounds(self):
  b=self.native_bounds(5,True);b['start']=400
  v.plan_native(b,900,['long-fixture'])
  self.assertFalse(b['nativeFull']);self.assertEqual(b['seconds'],5)
  for duration in [None,float('nan'),0]:
   with self.assertRaises(v.LimitError):v.plan_native(self.native_bounds(),duration,['fixture'])
  b=self.native_bounds(10,True);b['start']=5
  with self.assertRaisesRegex(v.LimitError,'native_range_outside_source'):v.plan_native(b,11,['fixture'])
 def test_native_invalid_params_do_not_change_non_gemini_limits(self):
  for fps in [0,-1,2,float('inf'),'1']:
   with self.assertRaises(v.LimitError):self.native_bounds(fps=fps)
  with self.assertRaises(v.LimitError):self.native_bounds(dimension=640)
  with self.assertRaises(v.LimitError):v.limits({'seconds':61})
  self.assertEqual(v.limits({})['seconds'],5)
 def test_below_one_fps_fine_variant_and_truncation_rejected(self):
  with tempfile.TemporaryDirectory() as root:
   source=self.fixture(root,11);b=self.native_bounds(fps=0.5,dimension=480);v.plan_native(b,11,['fixture'])
   r=v.native_clip(source,root,b,time.monotonic()+25)
   self.assertEqual(r['frameCount'],6);self.assertEqual(r['fps'],0.5)
  with tempfile.TemporaryDirectory() as root:
   source=self.fixture(root,11);b=self.native_bounds();v.plan_native(b,11,['fixture']);b['bytes']=4096
   with self.assertRaises(v.LimitError):v.native_clip(source,root,b,time.monotonic()+25)
 def test_long_automatic_whole_coverage_independent_threshold_runtime_and_bytes(self):
  for duration in [300,301,900,1800]:
   request={'seconds':1,'nativeClip':True,'nativeConfig':{'maxShort':300,'maxLong':1800,'fps':1,'dimension':360,'explicitRange':False,'version':'whole-short-v2','uniqueCap':1800}}
   b=v.limits(request);timeout=b['timeout'];budget=b['bytes']
   v.plan_native(b,duration,['fixture',duration])
   self.assertEqual(b['seconds'],duration);self.assertEqual(b['nativeMode'],'agentic');self.assertTrue(b['nativeFull'])
   self.assertEqual(b['timeout'],timeout);self.assertEqual(b['bytes'],budget)
  b=v.limits(request)
  with self.assertRaisesRegex(v.LimitError,'native_agentic_full_source_exceeds_coverage_budget'):v.plan_native(b,1801,['fixture'])
  request['nativeConfig']['maxLong']=3601
  with self.assertRaisesRegex(v.LimitError,'invalid_native_config'):v.limits(request)

if __name__=='__main__':unittest.main()
