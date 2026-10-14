import {createHash} from 'node:crypto';
import {hasCredentials} from './credentials.js';
export const TRANSFER_MAX_BYTES=8*1024*1024;
export function transferPath(input:string):string {
 const path=input.startsWith('/work/')?input.slice(6):input;
 if(path.length>240||!path||!path.split('/').every(s=>/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s))||/(?:^|[\/_.-])(?:credentials?|secrets?|tokens?|passwords?|passwd|shadow|cookies?|private|id_rsa|id_ed25519|\.env|system|proc|dev|etc|root|home)(?:$|[\/_.-])/i.test(path)||hasCredentials(path))throw new Error('Only nonsecret regular workspace files are transferable');
 return path;
}
// openat/no-follow for EVERY component; pinned descriptor; nonblocking to reject pipes,
// bounded pre/post stat and chunked read. Reject nested mounts incl same-device binds.
export const workspaceReadPython=String.raw`
import os,sys,stat,json,base64,hashlib
try:
 p=sys.argv[1];cap=int(sys.argv[2])
 parts=p.split('/')
 if not parts or any(not s or s in ('.','..') or s.startswith('.') for s in parts): raise ValueError()
 root=os.open('/work',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fd=root; opened=[root]
 try:
  mounts=open('/proc/self/mountinfo').read().splitlines()
  for line in mounts:
   mount=line.split(' - ')[0].split()[4]
   for code,char in [('\\040',' '),('\\011','\t'),('\\012','\n'),('\\134','\\')]: mount=mount.replace(code,char)
   if mount.startswith('/work/') and (('/work/'+p)==mount or ('/work/'+p).startswith(mount+'/')): raise ValueError()
  for i,part in enumerate(parts):
   flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
   if i<len(parts)-1: flags|=os.O_DIRECTORY
   fd=os.open(part,flags,dir_fd=fd);opened.append(fd)
   if os.fstat(fd).st_dev!=os.fstat(root).st_dev: raise ValueError()
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or not 0<before.st_size<=cap: raise ValueError()
  chunks=[];count=0
  while True:
   b=os.read(fd,min(65536,cap+1-count))
   if not b:break
   count+=len(b)
   if count>cap:raise ValueError()
   chunks.append(b)
  after=os.fstat(fd)
  if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or count!=before.st_size:raise ValueError()
  data=b''.join(chunks)
  print(json.dumps({'data':base64.b64encode(data).decode(),'sha256':hashlib.sha256(data).hexdigest(),'bytes':count}))
 finally:
  for n in reversed(opened):os.close(n)
except Exception:
 print(json.dumps({'error':'Workspace file read denied or unavailable'}));sys.exit(1)
`;
export interface WorkspaceBytes {data:Buffer;sha256:string;bytes:number;path:string;box:string}
export function decodeWorkspaceBytes(output:string,path:string,box:string,cap:number):WorkspaceBytes {
 const v=JSON.parse(output);if(v.error||typeof v.data!=='string'||v.data.length>Math.ceil(cap/3)*4+4)throw new Error('Workspace file read denied or unavailable');
 const data=Buffer.from(v.data,'base64');
 if(!data.length||data.length>cap||data.toString('base64')!==v.data||v.bytes!==data.length||createHash('sha256').update(data).digest('hex')!==v.sha256)throw new Error('Workspace file size or integrity failure');
 // Best-effort recognizable secret content exclusion, not arbitrary secret detection.
 if(hasCredentials(data.toString('utf8')))throw new Error('Credential-like file contents cannot be transferred');
 return {data,sha256:v.sha256,bytes:data.length,path,box};
}
