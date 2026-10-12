"""Audio-only negotiation using the pinned native client's existing settings."""
from discord.ext.native_voice import VoiceClient


class AudioOnlyVoiceClient(VoiceClient):
    auto_video_codec_capabilities = False
    auto_video_codec_priority = False
    voice_codec_specs = tuple(codec for codec in VoiceClient.voice_codec_specs
                              if codec.type == "audio" and codec.name.lower() == "opus")
