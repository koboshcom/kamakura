"""Private IPC DM adapter for the pinned self-account, not a bot client."""
import asyncio
import json
import os
import stat
import time

class TextDM:
    def __init__(self, client, discord, owners, self_id):
        self.client, self.discord, self.owners, self.self_id = client, discord, owners, self_id
        self.reader = self.writer = self.task = None
        self.channels, self.accepted, self.requests = {}, {}, set()
        self.lock = asyncio.Lock()
        self.enabled = os.environ.get("DISCORD_SELF_DM_ENABLED") == "true"

    async def write(self, obj):
        if not self.writer or self.writer.is_closing():
            raise ValueError("Text IPC unavailable")
        raw = (json.dumps(obj, ensure_ascii=True) + "\n").encode()
        if len(raw) > 49152:
            raise ValueError("Text IPC budget")
        async with self.lock:
            if self.writer.transport.get_write_buffer_size() > 65536:
                raise ValueError("Text IPC backpressure")
            self.writer.write(raw)
            await asyncio.wait_for(self.writer.drain(), 3)

    async def ready(self):
        if not self.enabled:
            return
        if not self.client.user or str(self.client.user.id) != self.self_id:
            raise ValueError("Self identity mismatch")
        if not self.writer:
            path, token = os.environ["DISCORD_TEXT_IPC_PATH"], os.environ["DISCORD_TEXT_IPC_TOKEN"]
            for name, mode in ((os.path.dirname(path), 0o700), (path, 0o600)):
                st = os.lstat(name)
                valid = stat.S_ISDIR(st.st_mode) if mode == 0o700 else stat.S_ISSOCK(st.st_mode)
                if not valid or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
                    raise ValueError("Unsafe text IPC")
            if not os.path.isabs(path) or len(token) != 64:
                raise ValueError("Invalid text IPC")
            self.reader, self.writer = await asyncio.open_unix_connection(path, limit=49152)
            await self.write({"type": "hello", "self": self.self_id, "token": token})
            hello = json.loads(await asyncio.wait_for(self.reader.readline(), 3))
            if hello.get("type") != "hello":
                raise ValueError("Text IPC handshake")
            self.task = asyncio.create_task(self.commands())
        await self.write({"type": "ready", "self": self.self_id})

    def valid(self, channel, account):
        return (isinstance(channel, self.discord.DMChannel)
                and str(getattr(getattr(channel, "recipient", None), "id", "")) == account
                and self.owners.get(account) is not None
                and self.client.user and str(self.client.user.id) == self.self_id)

    async def message(self, m):
        if not self.enabled or not self.writer:
            return
        account, channel, mid = str(m.author.id), m.channel, str(m.id)
        if (account == self.self_id or not self.valid(channel, account)
            or getattr(m, "guild", None) is not None or m.author.bot
            or getattr(m, "webhook_id", None) or m.is_system()
            or len(m.content) > 8000):
            return
        at = int(m.created_at.timestamp() * 1000)
        if abs(time.time() * 1000 - at) > 120000:
            return
        cid = str(channel.id)
        previous = self.channels.get(account)
        if previous is not None and str(previous.id) != cid:
            return
        now = time.monotonic()
        self.accepted = {k: expiry for k, expiry in self.accepted.items() if expiry > now}
        if (cid, mid) in self.accepted or len(self.accepted) >= 4096:
            return
        self.channels[account] = channel
        self.accepted[(cid, mid)] = now + 300
        attachments = [{"url": a.url, "mime": a.content_type or "", "size": a.size}
                       for a in m.attachments[:4]]
        await self.write({"type": "message", "self": self.self_id, "account": account,
                          "owner": self.owners[account], "channel": cid, "id": mid,
                          "text": m.content, "at": at, "recipient": account,
                          "dm": True, "guild": False, "group": False,
                          "bot": False, "webhook": False, "system": False,
                          "reference": m.reference is not None, "embeds": bool(m.embeds),
                          "snapshots": bool(getattr(m, "message_snapshots", [None])),
                          "attachments": attachments})

    async def command(self, m):
        request = m.get("request")
        if not isinstance(request, str) or len(request) != 32 or any(c not in "0123456789abcdef" for c in request):
            raise ValueError("Invalid request")
        if request in self.requests or len(self.requests) >= 4096:
            raise ValueError("Duplicate request")
        self.requests.add(request)  # Claim before side effect, never retry ambiguous delivery.
        account, cid = m.get("account"), m.get("channel")
        channel = self.channels.get(account)
        if (m.get("self") != self.self_id or not channel or not self.valid(channel, account)
            or self.owners.get(account) != m.get("owner") or str(channel.id) != cid):
            raise ValueError("Destination denied")
        if m.get("type") == "send":
            text = m.get("text")
            if not isinstance(text, str) or not text or len(text) > 2000:
                raise ValueError("Text budget")
            reply = m.get("replyTo")
            if reply and self.accepted.get((cid, reply), 0) <= time.monotonic():
                raise ValueError("Reply denied")
            await channel.send(text, allowed_mentions=self.discord.AllowedMentions.none(),
                               **({"reference": channel.get_partial_message(int(reply)),
                                   "mention_author": False} if reply else {}))
        elif m.get("type") == "react":
            mid, emoji = m.get("id"), m.get("emoji")
            if self.accepted.get((cid, mid), 0) <= time.monotonic() or not isinstance(emoji, str) or not emoji or len(emoji) > 16:
                raise ValueError("Reaction denied")
            await channel.get_partial_message(int(mid)).add_reaction(emoji)
        else:
            raise ValueError("Command denied")

    async def commands(self):
        try:
            while True:
                raw = await self.reader.readline()
                if not raw:
                    break
                m = json.loads(raw)
                try:
                    await asyncio.wait_for(self.command(m), 12)
                    ok = True
                except Exception:
                    ok = False
                await self.write({"type": "result", "request": m.get("request"), "ok": ok})
        except Exception:
            pass  # Do not log text, tokens, signed URLs or raw HTTP errors.
        finally:
            if self.writer:
                self.writer.close()

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        if self.writer:
            self.writer.close()
