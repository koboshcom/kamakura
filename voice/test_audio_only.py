import unittest
from unittest.mock import patch
from audio_only import AudioOnlyVoiceClient
from discord.ext.native_voice import VoiceClient


class AudioOnlyTests(unittest.TestCase):
    def test_opus_only_never_probes_video(self):
        def forbidden(*args, **kwargs):
            raise AssertionError("Video capability probe called")
        with patch("discord.ext.native_voice.client.get_local_video_codec_capabilities", forbidden):
            self.assertFalse(AudioOnlyVoiceClient.auto_video_codec_capabilities)
            self.assertFalse(AudioOnlyVoiceClient.auto_video_codec_priority)
            self.assertEqual(len(AudioOnlyVoiceClient.voice_codec_specs), 1)
            inherited = [c for c in VoiceClient.voice_codec_specs
                         if c.type == "audio" and c.name.lower() == "opus"]
            self.assertEqual(len(inherited), 1)
            for rtx in (True, False):
                codecs = AudioOnlyVoiceClient.get_voice_codecs(rtx=rtx, refresh_capabilities=True)
                self.assertEqual([c.to_dict() for c in codecs],
                                 [inherited[0].replace(priority=1000).to_dict()])
                self.assertEqual([(c.type, c.name.lower()) for c in codecs], [("audio", "opus")])


if __name__ == "__main__":
    unittest.main()
