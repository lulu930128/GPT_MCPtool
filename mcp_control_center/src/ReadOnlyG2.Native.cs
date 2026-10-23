// DEPRECATED historical G2 prototype; not composed by the tray.
// Current path/tests: WorkspaceLocal.Native.cs and test-workspace-local.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace McpCc.ReadOnlyG2 {
    // This assembly has no lifecycle or process-launch API. The existing owner
    // publishes a sanitized in-memory sample; IPC never starts a new probe job.
    public static class Contract {
        public const int MaxBytes = 16384, DeadlineMs = 1800;
        public const string Root = @"C:\Program Files\McpControlCenterG2";
        public const string PipeName = "mcpcc-readonly-g2-v1";
        public static readonly string[] Ids = { "codex_bridge", "omi_search", "japanese_study", "memory_core", "personal_asset_os", "english_study", "listening_audio" };
        public static readonly string[] Actions = { "ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime" };
        public static readonly string[] States = { "Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch", "OwnershipUnknown", "Misconfigured", "NotInstalled", "UNVERIFIED" };
        internal static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=MaxBytes, RecursionLimit=12 }; }
        public static string Nonce() { byte[] b=new byte[32]; using(var rng=RandomNumberGenerator.Create()) rng.GetBytes(b); return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        public static bool Has(string[] values, string value) { return Array.IndexOf(values,value)>=0; }
        // Restricted flat JSON: only unescaped ASCII strings. Reject duplicate,
        // unknown, escaped and case-variant keys before the JSON deserializer.
        public static Dictionary<string,string> Request(string json, string challenge) {
            if (json==null || Encoding.UTF8.GetByteCount(json)>2048 ||
                !Regex.IsMatch(json,@"\A\s*\{\s*""[A-Za-z]+""\s*:\s*""[a-zA-Z0-9_-]*""(?:\s*,\s*""[A-Za-z]+""\s*:\s*""[a-zA-Z0-9_-]*"")*\s*\}\s*\z")) throw new InvalidOperationException("INVALID_REQUEST");
            var result=new Dictionary<string,string>(StringComparer.Ordinal);
            foreach(Match m in Regex.Matches(json,@"""([A-Za-z]+)""\s*:\s*""([a-zA-Z0-9_-]*)""")) result.Add(m.Groups[1].Value,m.Groups[2].Value);
            string[] keys={"v","nonce","challenge","operation","componentId","action","requestId"};
            if(result.Count!=keys.Length) throw new InvalidOperationException("INVALID_REQUEST");
            foreach(string key in keys) if(!result.ContainsKey(key)) throw new InvalidOperationException("INVALID_REQUEST");
            if(result["v"]!="1" || !Regex.IsMatch(result["nonce"],"\\A[0-9a-f]{64}\\z") ||
               result["challenge"]!=challenge || !Regex.IsMatch(challenge,"\\A[0-9a-f]{64}\\z")) throw new InvalidOperationException("REPLAY_OR_VERSION_REJECTED");
            string op=result["operation"], id=result["componentId"], action=result["action"], request=result["requestId"];
            if(op=="status" && (id=="" || Has(Ids,id)) && action=="" && request=="") return result;
            if(op=="preview" && Has(Ids,id) && Has(Actions,action) && request=="") return result;
            if(op=="receipt" && id=="" && action=="" && Regex.IsMatch(request,"\\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\z")) return result;
            throw new InvalidOperationException("INVALID_REQUEST");
        }
    }

    public sealed class Row {
        public string componentId { get; set; }
        public string status { get; set; }
        public string observedAt { get; set; }
        public string[] capabilities { get; set; }
    }
    public sealed class Snapshot {
        readonly Row[] rows;
        readonly long acquired=Stopwatch.GetTimestamp();
        public Snapshot(Row[] source) {
            if(source==null || source.Length!=7) throw new InvalidOperationException("SNAPSHOT_INVALID");
            var ids=new HashSet<string>(StringComparer.Ordinal); var copy=new List<Row>();
            foreach(Row r in source) {
                DateTimeOffset date;
                if(r==null || !Contract.Has(Contract.Ids,r.componentId) || !ids.Add(r.componentId) || !Contract.Has(Contract.States,r.status) ||
                    !DateTimeOffset.TryParse(r.observedAt,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out date) ||
                    Math.Abs((DateTimeOffset.UtcNow-date).TotalSeconds)>30 || r.capabilities==null || r.capabilities.Length>5) throw new InvalidOperationException("SNAPSHOT_INVALID");
                var caps=new HashSet<string>(StringComparer.Ordinal);
                foreach(string a in r.capabilities) if(!Contract.Has(Contract.Actions,a) || !caps.Add(a)) throw new InvalidOperationException("SNAPSHOT_INVALID");
                copy.Add(new Row { componentId=r.componentId,status=r.status,observedAt=date.ToString("o"),capabilities=(string[])r.capabilities.Clone() });
            }
            rows=copy.ToArray();
        }
        internal string Reply(Dictionary<string,string> r) {
            bool fresh=(Stopwatch.GetTimestamp()-acquired)/(double)Stopwatch.Frequency<=30;
            var selected=new List<Row>(); bool? supported=null;
            if(r["operation"]!="receipt" && fresh) foreach(Row row in rows) {
                if(r["componentId"]=="" || row.componentId==r["componentId"]) selected.Add(row);
            }
            if(r["operation"]=="preview" && fresh) supported=Contract.Has(selected[0].capabilities,r["action"]);
            string code=!fresh ? "SNAPSHOT_UNAVAILABLE" : r["operation"]=="status" ? "OWNER_OBSERVATION" : r["operation"]=="preview" ? "READ_ONLY_PREVIEW" : "RECEIPT_SOURCE_UNAVAILABLE";
            return Contract.Json().Serialize(new { v="1",nonce=r["nonce"],operation=r["operation"],componentId=r["componentId"],action=r["action"],requestId=r["requestId"],code=code,
                components=selected.ToArray(),supported=supported,mutationEnabled=false,allowed=false,executable=false,found=(object)null,completed=(object)null,receipt=(object)null });
        }
    }

    internal static class Native {
        [StructLayout(LayoutKind.Sequential)] internal struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern SafePipeHandle CreateNamedPipe(string name,uint mode,uint pipeMode,uint instances,uint output,uint input,uint timeout,ref SecurityAttributes security);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] internal static extern SafePipeHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] internal static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
        [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr data,int length,out int needed);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        internal static string Sid(Process process) {
            IntPtr token;
            if(!OpenProcessToken(process.Handle,8,out token)) throw new InvalidOperationException("PEER_TOKEN_UNAVAILABLE");
            try { using(var identity=new WindowsIdentity(token)) return identity.User.Value; }
            finally { CloseHandle(token); }
        }
        internal static bool Elevated(Process process) {
            IntPtr token;
            if(!OpenProcessToken(process.Handle,8,out token)) throw new InvalidOperationException("PEER_TOKEN_UNAVAILABLE");
            IntPtr data=Marshal.AllocHGlobal(4);
            try { int needed; if(!GetTokenInformation(token,20,data,4,out needed)) throw new InvalidOperationException("PEER_TOKEN_UNAVAILABLE"); return Marshal.ReadInt32(data)!=0; }
            finally { Marshal.FreeHGlobal(data);CloseHandle(token); }
        }
    }

    // PID/start time/SID/session/image are obtained from Windows, never a request.
    // Retain the process handle across the exchange; PID reuse cannot replace it.
    internal sealed class Peer : IDisposable {
        readonly Process process;
        readonly string sid,image;
        readonly int session;
        readonly long start;
        internal Peer(int pid,string expectedSid,int expectedSession,long expectedStart,string expectedImage) {
            process=Process.GetProcessById(pid);
            try {
                var retained=process.Handle;
                sid=expectedSid;session=expectedSession;start=expectedStart;image=expectedImage;
                Check();
            } catch { process.Dispose();throw; }
        }
        internal void Check() {
            if(process.HasExited || process.StartTime.ToUniversalTime().Ticks!=start || process.SessionId!=session || Native.Sid(process)!=sid || Native.Elevated(process) ||
                !String.Equals(process.MainModule.FileName,image,StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("PEER_IDENTITY_REJECTED");
        }
        internal void Server(NamedPipeClientStream pipe) { uint pid; Check();if(!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle,out pid) || pid!=process.Id) throw new InvalidOperationException("PEER_IDENTITY_REJECTED");Check(); }
        public void Dispose() { process.Dispose(); }
    }

    public sealed class Binding {
        public string contract {get;set;}
        public int ownerPid {get;set;}
        public long ownerStartedUtcTicks {get;set;}
        public string ownerSid {get;set;}
        public int ownerSession {get;set;}
        public string clientSid {get;set;}
        public int clientSession {get;set;}
        public Dictionary<string,string> files {get;set;}
    }
    public static class Installation {
        public static void AssertOwnerSource() {
            // Protected files on disk plus an exact powershell.exe process do
            // not attest its entry script, runspaces, loaded modules or closure.
            // No protected owner bootstrap/measurement exists in this slice.
            // This is deliberately non-configurable: binding JSON cannot waive it.
            throw new InvalidOperationException("PROTECTED_OWNER_SOURCE_UNVERIFIED");
        }
        static bool Trusted(string sid) { return sid=="S-1-5-18" || sid=="S-1-5-32-544" || sid=="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"; }
        public static void Acl(FileSystemSecurity acl,bool ancestor) {
            if(!Trusted(acl.GetOwner(typeof(SecurityIdentifier)).Value)) throw new InvalidOperationException("PROTECTED_OWNER_REQUIRED");
            var raw=new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(),0);
            if(raw.DiscretionaryAcl==null) throw new InvalidOperationException("PROTECTED_DACL_REQUIRED");
            var mask=FileSystemRights.Write|FileSystemRights.Delete|FileSystemRights.DeleteSubdirectoriesAndFiles|FileSystemRights.ChangePermissions|FileSystemRights.TakeOwnership;
            if(ancestor) mask &= ~(FileSystemRights.CreateFiles|FileSystemRights.CreateDirectories);
            foreach(FileSystemAccessRule ace in acl.GetAccessRules(true,true,typeof(SecurityIdentifier))) {
                if(ancestor && (ace.PropagationFlags&PropagationFlags.InheritOnly)!=0) continue;
                if(ace.AccessControlType==AccessControlType.Allow && !Trusted(ace.IdentityReference.Value) && (ace.FileSystemRights&mask)!=0) throw new InvalidOperationException("PROTECTED_WRITE_REJECTED");
            }
        }
        public static void PathGate(string path) {
            string cursor=Path.GetFullPath(path); bool first=true;
            while(cursor!=null) {
                if((File.GetAttributes(cursor)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("REPARSE_REJECTED");
                Acl(Directory.Exists(cursor) ? (FileSystemSecurity)new DirectoryInfo(cursor).GetAccessControl() : new FileInfo(cursor).GetAccessControl(),!first);
                first=false;cursor=Path.GetDirectoryName(cursor);
            }
        }
        public static Binding Verify() {
            PathGate(Contract.Root);
            string bindingPath=Path.Combine(Contract.Root,"binding.json");PathGate(bindingPath);
            if(new FileInfo(bindingPath).Length>Contract.MaxBytes) throw new InvalidOperationException("BINDING_LIMIT");
            var b=Contract.Json().Deserialize<Binding>(File.ReadAllText(bindingPath,new UTF8Encoding(false,true)));
            if(b==null || b.contract!="mcpcc-readonly-install-v1" || b.ownerPid<=0 || b.ownerStartedUtcTicks<=0 || b.ownerSession<0 || b.clientSession<0 ||
               b.ownerSid==b.clientSid || b.files==null || b.files.Count<4 || b.files.Count>256) throw new InvalidOperationException("BINDING_INVALID");
            new SecurityIdentifier(b.ownerSid);new SecurityIdentifier(b.clientSid);
            // A separate principal is mandatory: a same-user PowerShell process in
            // writable checkout cannot establish protected owner identity.
            string[] required={"mcp_control_center/src/ReadOnlyG2.Native.cs","mcp_control_center/src/McpControlCenter.ReadOnlyG2.psm1","mcp_control_center/src/McpControlCenter.Core.psm1","mcp_control_center/config/registry.json"};
            foreach(string name in required) if(!b.files.ContainsKey(name)) throw new InvalidOperationException("DEPENDENCY_MISSING");
            var seen=new HashSet<string>(StringComparer.Ordinal);var queue=new Queue<string>();queue.Enqueue(Contract.Root);
            int count=0;long total=0;
            using(var hash=SHA256.Create()) while(queue.Count>0) foreach(var item in new DirectoryInfo(queue.Dequeue()).GetFileSystemInfos()) {
                if(++count>512 || (item.Attributes&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("TREE_REJECTED");
                var dir=item as DirectoryInfo;
                Acl(dir!=null ? (FileSystemSecurity)dir.GetAccessControl() : ((FileInfo)item).GetAccessControl(),false);
                if(dir!=null) { queue.Enqueue(dir.FullName);continue; }
                string relative=item.FullName.Substring(Contract.Root.Length+1).Replace('\\','/');
                if(relative=="binding.json") continue;
                var file=(FileInfo)item;total+=file.Length;
                if(file.Length>4*1024*1024 || total>16*1024*1024 || !b.files.ContainsKey(relative)) throw new InvalidOperationException("UNPINNED_DEPENDENCY");
                using(var input=new FileStream(file.FullName,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                    string actual=BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                    if(actual!=b.files[relative]) throw new InvalidOperationException("DEPENDENCY_HASH_MISMATCH");
                }
                seen.Add(relative);
            }
            if(seen.Count!=b.files.Count) throw new InvalidOperationException("DEPENDENCY_MISSING");
            // G2's source gate is intentionally independent of R1/NormalOperator.
            // No installed-release imports or descriptor references outside this
            // immutable tree are allowed by the owner module.
            PathGate(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
            return b;
        }
    }

    internal static class Frame {
        internal static void Wait(Task task,Stopwatch clock,IDisposable pipe) {
            int remaining=Contract.DeadlineMs-(int)clock.ElapsedMilliseconds;
            try { if(remaining<=0 || !task.Wait(remaining)) throw new TimeoutException("IPC_TIMEOUT");task.GetAwaiter().GetResult(); }
            catch { pipe.Dispose();throw; }
        }
        static void Exact(PipeStream pipe,byte[] buffer,Stopwatch clock) {
            int offset=0;
            while(offset<buffer.Length) { var task=pipe.ReadAsync(buffer,offset,buffer.Length-offset);Wait(task,clock,pipe);int n=task.Result;if(n==0) throw new EndOfStreamException();offset+=n; }
        }
        internal static string Read(PipeStream pipe,Stopwatch clock) {
            byte[] header=new byte[4];Exact(pipe,header,clock);int length=BitConverter.ToInt32(header,0);
            if(length<1 || length>Contract.MaxBytes) throw new InvalidOperationException("FRAME_LIMIT");
            byte[] bytes=new byte[length];Exact(pipe,bytes,clock);return new UTF8Encoding(false,true).GetString(bytes);
        }
        internal static void Write(PipeStream pipe,string value,Stopwatch clock) {
            byte[] bytes=new UTF8Encoding(false,true).GetBytes(value);
            if(bytes.Length<1 || bytes.Length>Contract.MaxBytes) throw new InvalidOperationException("FRAME_LIMIT");
            byte[] header=BitConverter.GetBytes(bytes.Length);Wait(pipe.WriteAsync(header,0,4),clock,pipe);Wait(pipe.WriteAsync(bytes,0,bytes.Length),clock,pipe);
        }
    }

    public sealed class Owner : IDisposable {
        readonly Binding binding;
        readonly string name;
        readonly string ownerSid;
        readonly object sync=new object();
        Snapshot snapshot;
        NamedPipeServerStream current;
        Task worker;
        volatile bool stopped;
        public static Owner Open() {
            Installation.AssertOwnerSource();
            Binding b=Installation.Verify();
            using(var p=Process.GetCurrentProcess()) using(var peer=new Peer(b.ownerPid,b.ownerSid,b.ownerSession,b.ownerStartedUtcTicks,@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")) {
                if(p.Id!=b.ownerPid) throw new InvalidOperationException("OWNER_PROCESS_REQUIRED");peer.Check();
            }
            return new Owner(b,Contract.PipeName);
        }
        // Internal constructor is used by a same-assembly isolated fixture only.
        // No CLI, environment flag or exported PowerShell function can bypass Open.
        internal Owner(Binding b,string pipeName) { binding=b;name=pipeName;using(var i=WindowsIdentity.GetCurrent()) ownerSid=i.User.Value; }
        public void Publish(Snapshot sample) { if(sample==null) throw new ArgumentNullException("sample");lock(sync) snapshot=sample; }
        public void Start() { lock(sync) { if(worker!=null || stopped) throw new InvalidOperationException("ALREADY_STARTED");current=Create();worker=Task.Run((Action)Loop); } }
        NamedPipeServerStream Create() {
            string sddl="O:"+ownerSid+"D:P(A;;0x0012019f;;;"+ownerSid+")";
            if(binding.clientSid!=ownerSid) sddl+="(A;;0x00100003;;;"+binding.clientSid+")";
            var security=new RawSecurityDescriptor(sddl);byte[] bytes=new byte[security.BinaryLength];security.GetBinaryForm(bytes,0);
            var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);SafePipeHandle handle=null;
            try {
                var attributes=new Native.SecurityAttributes {length=Marshal.SizeOf(typeof(Native.SecurityAttributes)),descriptor=pinned.AddrOfPinnedObject(),inherit=false};
                handle=Native.CreateNamedPipe(@"\\.\pipe\"+name,3|0x00080000|0x40000000,8,1,Contract.MaxBytes+4,Contract.MaxBytes+4,Contract.DeadlineMs,ref attributes);
                if(handle.IsInvalid) throw new InvalidOperationException("PIPE_BIND_REJECTED");
                var pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);handle=null;return pipe;
            } finally { if(handle!=null) handle.Dispose();pinned.Free(); }
        }
        void Client(NamedPipeServerStream pipe) {
            uint pid;if(!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle,out pid)) throw new InvalidOperationException("CLIENT_IDENTITY_UNAVAILABLE");
            using(var p=Process.GetProcessById((int)pid)) {
                var retained=p.Handle;
                if(p.HasExited || Native.Sid(p)!=binding.clientSid || p.SessionId!=binding.clientSession || Native.Elevated(p)) throw new InvalidOperationException("CLIENT_IDENTITY_REJECTED");
            }
        }
        void Loop() {
            while(!stopped) {
                var pipe=current;
                try {
                    pipe.WaitForConnection();var clock=Stopwatch.StartNew();Client(pipe);
                    string challenge=Contract.Nonce();Frame.Write(pipe,challenge,clock);
                    var request=Contract.Request(Frame.Read(pipe,clock),challenge);Client(pipe);
                    Snapshot sample;lock(sync) sample=snapshot;
                    if(sample==null) throw new InvalidOperationException("SNAPSHOT_UNAVAILABLE");
                    Frame.Write(pipe,sample.Reply(request),clock);Client(pipe);
                } catch { /* No raw error or payload log; this exchange is closed. */ }
                finally { pipe.Dispose(); }
                lock(sync) {
                    if(stopped) return;
                    try { current=Create(); } catch { stopped=true;return; }
                }
            }
        }
        public void Dispose() { lock(sync) { stopped=true;if(current!=null) current.Dispose(); } if(worker!=null) worker.Wait(Contract.DeadlineMs+100); }
    }

    public static class Client {
        public static string Query(string operation,string componentId,string action,string requestId,string nonce) {
            var b=Installation.Verify();
            using(var identity=WindowsIdentity.GetCurrent()) if(identity.User.Value!=b.clientSid) throw new InvalidOperationException("CLIENT_IDENTITY_REJECTED");
            using(var peer=new Peer(b.ownerPid,b.ownerSid,b.ownerSession,b.ownerStartedUtcTicks,@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")) {
                return Exchange(Contract.PipeName,operation,componentId,action,requestId,nonce,peer);
            }
        }
        internal static string Exchange(string name,string operation,string componentId,string action,string requestId,string nonce,Peer peer) {
            var clock=Stopwatch.StartNew();
            // Identification SQOS prevents a server impersonating the caller.
            using(var handle=Native.CreateFile(@"\\.\pipe\"+name,0x00100003,0,IntPtr.Zero,3,0x40000000|0x00100000|0x00010000,IntPtr.Zero)) {
                if(handle.IsInvalid) throw new IOException("NOT_CONNECTED");
                using(var pipe=new NamedPipeClientStream(PipeDirection.InOut,true,true,handle)) {
                    if(peer!=null) peer.Server(pipe);
                    string challenge=Frame.Read(pipe,clock);
                    string request=Contract.Json().Serialize(new {v="1",nonce=nonce,challenge=challenge,operation=operation,componentId=componentId,action=action,requestId=requestId});
                    Contract.Request(request,challenge);Frame.Write(pipe,request,clock);
                    string response=Frame.Read(pipe,clock);if(peer!=null) peer.Server(pipe);return response;
                }
            }
        }
    }
}
