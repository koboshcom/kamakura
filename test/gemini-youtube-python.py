import importlib.util,sys,types,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('video','deploy/video-link.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class Tests(unittest.TestCase):
 def test_metadata_never_selects_format_or_downloads_media(self):
  seen=[]
  class DL:
   def __init__(self,opts):seen.append(opts);self.opts=opts
   def __enter__(self):return self
   def __exit__(self,*args):pass
   def extract_info(self,url,download,process):
    self_test.assertFalse(download);self_test.assertFalse(process)
    return {'duration':15,'id':'oNNZJKX2KOU'}
  self_test=self
  with patch.dict(sys.modules,{'yt_dlp':types.SimpleNamespace(YoutubeDL=DL)}):
   r=v.inspect({'url':'https://youtube.com/shorts/oNNZJKX2KOU','nativeMetadata':True,'seconds':1,'frames':1,'bytes':2097152,'timeout':20},downloader=lambda *a:self.fail('must not download'),decoder=lambda *a:self.fail('must not decode'))
  self.assertEqual(r['duration'],15);self.assertEqual(r['videoDownloadBytes'],0)
  self.assertTrue(seen[0]['noplaylist']);self.assertTrue(seen[0]['skip_download']);self.assertFalse(seen[0]['usenetrc']);self.assertEqual(seen[0]['retries'],0)
 def test_unknown_duration_and_live_rejected(self):
  for info in [{'duration':90,'_type':'url','url':'private'}, {'duration':None},{'duration':float('nan')},{'duration':15,'is_live':True},{'duration':15,'has_drm':True}]:
   class DL:
    def __init__(self,*a):pass
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def extract_info(self,*a,**k):return info
   with patch.dict(sys.modules,{'yt_dlp':types.SimpleNamespace(YoutubeDL=DL)}):
    with self.assertRaises(v.LimitError):v.native_metadata('https://www.youtube.com/watch?v=oNNZJKX2KOU',v.limits({'bytes':2097152}))
 def test_actual_metadata_and_fallback_commands_are_no_playlist_and_canonical(self):
  with open('deploy/video-link.py') as f:source=f.read()
  self.assertIn("'noplaylist':True",source[source.index('def download('):source.index('def download(')+1500])
  self.assertIn('url=canonical_youtube(url)',source[source.index('def download('):source.index('def download(')+1500])
  self.assertIn("'noplaylist':True",source[source.index('def native_metadata('):source.index('def native_metadata(')+1500])
  self.assertEqual(v.canonical_youtube('https://www.youtube.com/watch?v=8jppMQSi_rE&list=RDH_Ab3nKZUfM&index=8'),'https://www.youtube.com/watch?v=8jppMQSi_rE')
  for url in ['https://youtube.com/watch?v=8jppMQSi_rE&v=8jppMQSi_rE','https://youtube.com/watch?v=%38jppMQSi_rE','https://youtube.com/watch?v=8jppMQSi_rE&%76=8jppMQSi_rE','https://youtube.com/playlist?list=x']:
   with self.assertRaises(v.LimitError):v.canonical_youtube(url)
if __name__=='__main__':unittest.main()
