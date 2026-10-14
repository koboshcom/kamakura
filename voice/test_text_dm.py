import asyncio
import time
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from text_dm import TextDM

class DM:
    def __init__(self, account=11, cid=44):
        self.recipient=SimpleNamespace(id=account)
        self.id=cid
        self.send=AsyncMock()
        self.partial=SimpleNamespace(add_reaction=AsyncMock())
    def get_partial_message(self, mid):
        return self.partial

class TextTests(unittest.IsolatedAsyncioTestCase):
    def make(self):
        d=SimpleNamespace(DMChannel=DM,AllowedMentions=SimpleNamespace(none=lambda:'none'))
        adapter=TextDM(SimpleNamespace(user=SimpleNamespace(id=33)),d,{'11':'91','22':'92'},'33')
        adapter.enabled=True;adapter.writer=object();adapter.write=AsyncMock()
        return adapter
    def msg(self, channel=None, **kw):
        m=SimpleNamespace(author=SimpleNamespace(id=11,bot=False),channel=channel or DM(),id=55,guild=None,webhook_id=None,content='hello',created_at=datetime.now(timezone.utc),attachments=[],reference=None,embeds=[],is_system=lambda:False)
        for k,v in kw.items():setattr(m,k,v)
        return m
    async def test_filter_echo_foreign_group_bot_system(self):
        a=self.make()
        for m in [self.msg(author=SimpleNamespace(id=33,bot=False)),self.msg(channel=DM(99)),self.msg(channel=object()),self.msg(guild=object()),self.msg(author=SimpleNamespace(id=11,bot=True)),self.msg(webhook_id=1),self.msg(is_system=lambda:True)]:
            await a.message(m)
        self.assertEqual(a.write.await_count,0)
    async def test_inbound_duplicate_and_real_metadata(self):
        a=self.make();m=self.msg(attachments=[SimpleNamespace(url='https://cdn.discordapp.com/attachments/1/2/3.mp4',content_type='video/mp4',size=50)])
        await a.message(m);await a.message(m)
        self.assertEqual(a.write.await_count,1)
        row=a.write.call_args.args[0]
        self.assertEqual(row['owner'],'91');self.assertEqual(row['account'],'11');self.assertEqual(row['attachments'][0]['mime'],'video/mp4')
    async def test_send_ack_only_after_sdk_success_reply_and_no_mentions(self):
        a=self.make();channel=DM();await a.message(self.msg(channel))
        m={'request':'a'*32,'type':'send','account':'11','owner':'91','channel':'44','self':'33','text':'result','replyTo':'55'}
        await a.command(m)
        channel.send.assert_awaited_once()
        self.assertEqual(channel.send.call_args.kwargs['allowed_mentions'],'none')
        self.assertFalse(channel.send.call_args.kwargs['mention_author'])
        with self.assertRaises(ValueError):await a.command(m)
        bad={**m,'request':'b'*32,'account':'22','owner':'92'}
        with self.assertRaises(ValueError):await a.command(bad)
        channel.send.side_effect=RuntimeError('private HTTP error')
        with self.assertRaises(RuntimeError):await a.command({**m,'request':'c'*32})
    async def test_reaction_requires_accepted_target(self):
        a=self.make();channel=DM();await a.message(self.msg(channel))
        m={'request':'d'*32,'type':'react','account':'11','owner':'91','channel':'44','self':'33','id':'55','emoji':'⭐'}
        await a.command(m);channel.partial.add_reaction.assert_awaited_once_with('⭐')
        with self.assertRaises(ValueError):await a.command({**m,'request':'e'*32,'id':'66'})
    async def test_disabled_no_reader_or_messages(self):
        a=self.make();a.enabled=False;await a.ready();await a.message(self.msg());self.assertEqual(a.write.await_count,0)

    async def test_chunked_upload_exact_owner_ack_and_no_retry(self):
        import base64
        a=self.make();channel=DM();await a.message(self.msg(channel))
        class File:
            def __init__(self, fp, filename):
                self.fp,self.filename=fp,filename
            def close(self):self.fp.close()
        a.discord.File=File
        channel.send.return_value=SimpleNamespace(id=99,channel=channel,attachments=[object()])
        counter=0
        def command(kind, **kw):
            nonlocal counter
            counter+=1
            return dict(request=format(counter,'032x'),type=kind,account='11',owner='91',channel='44',self='33',upload='f'*32,**kw)
        await a.command(command('file_begin',size=3,filename='safe.txt'))
        with self.assertRaises(ValueError):
            await a.command({**command('file_chunk',offset=0,data=base64.b64encode(b'abc').decode()),'owner':'92'})
        self.assertEqual(channel.send.await_count,0)
        await a.command(command('file_chunk',offset=0,data=base64.b64encode(b'abc').decode()))
        await a.command(command('file_finish'))
        self.assertEqual(channel.send.await_count,1)
        self.assertEqual(channel.send.call_args.kwargs['allowed_mentions'],'none')
        with self.assertRaises(ValueError):await a.command(command('file_finish'))
        self.assertEqual(channel.send.await_count,1)
    async def test_upload_caps_incomplete_and_sdk_failure(self):
        import base64
        a=self.make();channel=DM();await a.message(self.msg(channel))
        class File:
            def __init__(self, fp, filename):self.fp=fp
            def close(self):self.fp.close()
        a.discord.File=File
        counter=0
        def command(kind, **kw):
            nonlocal counter
            counter+=1
            return dict(request=format(counter,'032x'),type=kind,account='11',owner='91',channel='44',self='33',upload='a'*32,**kw)
        for size,filename in [(8388609,'a.txt'),(3,'../outside'),(0,'a.txt')]:
            with self.assertRaises(ValueError):await a.command(command('file_begin',size=size,filename=filename))
        await a.command(command('file_begin',size=3,filename='a.txt'))
        with self.assertRaises(ValueError):await a.command(command('file_finish'))
        self.assertEqual(channel.send.await_count,0)
        await a.command(command('file_begin',size=3,filename='a.txt'))
        with self.assertRaises(ValueError):await a.command(command('file_chunk',offset=1,data='YWJj'))
        await a.command(command('file_chunk',offset=0,data='YWJj'))
        channel.send.side_effect=RuntimeError('sdk error')
        with self.assertRaises(RuntimeError):await a.command(command('file_finish'))
        with self.assertRaises(ValueError):await a.command(command('file_finish'))
        self.assertEqual(channel.send.await_count,1)

if __name__=='__main__':unittest.main()
