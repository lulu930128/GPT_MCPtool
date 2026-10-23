using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Tasks;
using System.Threading;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Transport only. This class cannot issue/consume a Grant or launch a process. The
// protected composition root supplies retained peers AFTER its installed-owner gate.
// No caller JSON, PID field, SID string or successful pipe exchange is an approval.
public static class McpCcNormalPipe {
    public const int MaxFrameBytes = 131072;
    public const int DeadlineMilliseconds = 5500;
    const uint Duplex = 3, FirstInstance = 0x00080000, Overlapped = 0x40000000;
    const uint RejectRemote = 8, ReadWriteSynchronize = 0x00120003; // includes READ_CONTROL for DACL verification
    const uint SqosPresent = 0x00100000, Identification = 0x00010000;

    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes {
        public int length;
        public IntPtr descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool inherit;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint openMode, uint pipeMode,
        uint instances, uint outputBytes, uint inputBytes, uint timeout, ref SecurityAttributes security);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafePipeHandle CreateFile(string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);

    // A retained handle prevents a reused PID from becoming a new authority. The
    // snapshot is captured from the OS and never deserialized from a protocol message.
    public sealed class Peer : IDisposable {
        readonly Process process;
        readonly McpCcNormalNative.Proof proof;
        readonly McpCcNormalSecurity.TokenProof token;
        readonly bool independent;
        bool disposed;
        Peer parent;
        Peer(Process retained, bool requireIndependent) {
            process=retained;
            independent=requireIndependent;
            proof=McpCcNormalNative.Inspect(process);
            token=McpCcNormalSecurity.Observe(process);
            McpCcNormalSecurity.AssertNormal(token,proof.sid,proof.session);
            if (proof.elevated || (independent && proof.inAnyJob))
                throw new InvalidOperationException("IPC_PEER_TOKEN_REJECTED");
        }
        public static Peer Retain(int pid, string sid, string image, int session, long startedUtcTicks,
            bool requireIndependent) {
            Process p=Process.GetProcessById(pid);
            try {
                Peer peer=new Peer(p, requireIndependent);
                if (peer.proof.sid!=sid || peer.proof.session!=session || peer.proof.startedUtcTicks!=startedUtcTicks ||
                    !String.Equals(peer.proof.image,image,StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("IPC_PEER_IDENTITY_REJECTED");
                return peer;
            } catch { p.Dispose(); throw; }
        }
        public int Pid { get { Check(); return proof.pid; } }
        public string Sid { get { Check(); return proof.sid; } }
        public Peer BindParent(Peer retainedParent) {
            Check();
            if(parent!=null || retainedParent==null || retainedParent==this || retainedParent.parent!=null
                || retainedParent.proof.session!=proof.session || retainedParent.proof.sid!=proof.sid
                || retainedParent.token.logonId!=token.logonId || retainedParent.proof.startedUtcTicks>proof.startedUtcTicks)
                throw new InvalidOperationException("IPC_PARENT_REJECTED");
            retainedParent.Check(); parent=retainedParent; return this;
        }
        public void Check() {
            if (disposed) throw new ObjectDisposedException("IPC_PEER_CLOSED");
            if(parent!=null) parent.Check();
            var actual=McpCcNormalNative.Inspect(process);
            McpCcNormalSecurity.AssertUnchanged(process,token);
            if (actual.pid!=proof.pid || actual.sid!=proof.sid || actual.session!=proof.session ||
                actual.startedUtcTicks!=proof.startedUtcTicks || actual.elevated || (independent && actual.inAnyJob) ||
                !String.Equals(actual.image,proof.image,StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("IPC_PEER_CHANGED");
        }
        internal void AssertClient(NamedPipeServerStream pipe) {
            Check();
            using(var self=WindowsIdentity.GetCurrent())
                McpCcNormalSecurity.AssertClient(pipe,process,token,proof,self.User.Value);
            Check();
        }
        internal void AssertServer(NamedPipeClientStream pipe) {
            Check();
            using(var self=WindowsIdentity.GetCurrent())
                McpCcNormalSecurity.AssertServer(pipe,process,token,proof,self.User.Value,independent);
            Check();
        }
        public void Dispose() { if (!disposed) { disposed=true; process.Dispose(); if(parent!=null) parent.Dispose(); } }
    }

    public static byte[] Descriptor(string ownerSid, string clientSid) {
        // The server's duplex CreateNamedPipe handle requires FILE_GENERIC_READ /
        // FILE_GENERIC_WRITE, including FILE_CREATE_PIPE_INSTANCE. A different client
        // SID receives data read/write + synchronize + DACL read. Same-SID isolation comes
        // from first-instance/maxInstances=1 and retained exact peers, never this ACL.
        ownerSid=new SecurityIdentifier(ownerSid).Value;
        clientSid=new SecurityIdentifier(clientSid).Value;
        string sddl="O:"+ownerSid+"D:P(A;;0x0012019f;;;"+ownerSid+")";
        if (clientSid!=ownerSid) sddl+="(A;;0x00120003;;;"+clientSid+")";
        var descriptor=new RawSecurityDescriptor(sddl);
        byte[] bytes=new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(bytes,0);
        return bytes;
    }
    static string Name(Guid channel) {
        if (channel==Guid.Empty) throw new InvalidOperationException("IPC_CHANNEL_INVALID");
        return @"\\.\pipe\codex-normal-v1-"+channel.ToString("N");
    }
    static int Remaining(Stopwatch clock,int deadline=DeadlineMilliseconds) {
        long remaining=deadline-clock.ElapsedMilliseconds;
        if (remaining<=0) throw new TimeoutException("IPC_DEADLINE");
        return (int)remaining;
    }
    static void Wait(Task task, Stopwatch clock, IDisposable pipe,int deadline=DeadlineMilliseconds) {
        // Dispose cancels the native overlapped operation. A late completion never
        // receives another frame or a retry. Observe exceptions without raw output.
        try {
            if (!task.Wait(Remaining(clock,deadline))) { pipe.Dispose(); throw new TimeoutException("IPC_DEADLINE"); }
            task.GetAwaiter().GetResult();
        } catch { pipe.Dispose(); throw; }
    }
    static void Write(PipeStream pipe, byte[] value, Stopwatch clock,int deadline=DeadlineMilliseconds) {
        if (value==null || value.Length<1 || value.Length>MaxFrameBytes)
            throw new InvalidOperationException("IPC_FRAME_REJECTED");
        byte[] length=BitConverter.GetBytes(value.Length);
        Wait(pipe.WriteAsync(length,0,4),clock,pipe,deadline);
        Wait(pipe.WriteAsync(value,0,value.Length),clock,pipe,deadline);
    }
    static void ReadExact(PipeStream pipe, byte[] buffer, Stopwatch clock,int deadline=DeadlineMilliseconds) {
        int offset=0;
        while (offset<buffer.Length) {
            Task<int> pending=pipe.ReadAsync(buffer,offset,buffer.Length-offset);
            Wait(pending,clock,pipe,deadline);
            int count=pending.GetAwaiter().GetResult();
            if (count==0) throw new EndOfStreamException("IPC_CLOSED");
            offset+=count;
        }
    }
    static byte[] Read(PipeStream pipe, Stopwatch clock,int deadline=DeadlineMilliseconds) {
        byte[] size=new byte[4]; ReadExact(pipe,size,clock,deadline);
        int count=BitConverter.ToInt32(size,0);
        if (count<1 || count>MaxFrameBytes) throw new InvalidOperationException("IPC_FRAME_REJECTED");
        byte[] value=new byte[count]; ReadExact(pipe,value,clock,deadline); return value;
    }

    public sealed class Listener : IDisposable {
        readonly NamedPipeServerStream pipe;
        readonly Peer client;
        bool used;
        public Listener(Guid channel, Peer expectedClient) {
            if (expectedClient==null) throw new ArgumentNullException("expectedClient");
            client=expectedClient; client.Check();
            pipe=OpenListener(channel,client.Sid);
        }
        public Listener(Guid channel,string allowedClientSid) {
            pipe=OpenListener(channel,allowedClientSid);
        }
        static NamedPipeServerStream OpenListener(Guid channel,string clientSid) {
            string owner;
            using(var identity=WindowsIdentity.GetCurrent()) owner=identity.User.Value;
            byte[] descriptor=Descriptor(owner,clientSid);
            GCHandle pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
            SafePipeHandle handle=null;
            try {
                var security=new SecurityAttributes { length=Marshal.SizeOf(typeof(SecurityAttributes)),
                    descriptor=pinned.AddrOfPinnedObject(), inherit=false };
                handle=CreateNamedPipe(Name(channel),Duplex|FirstInstance|Overlapped,RejectRemote,
                    1,MaxFrameBytes+4,MaxFrameBytes+4,DeadlineMilliseconds,ref security);
                if (handle.IsInvalid) {
                    var error=new Win32Exception(Marshal.GetLastWin32Error());
                    error.Data["operation"]="CreateNamedPipe(first-instance, duplex, remote-reject)";
                    throw error;
                }
                var stream=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);
                handle=null; // Stream owns the handle.
                return stream;
            } finally { if (handle!=null) handle.Dispose(); pinned.Free(); }
        }
        // A listener accepts exactly one exchange, including on failure. It does not
        // reconnect to another peer or retain reusable authorization material.
        public byte[] Exchange(Func<byte[],byte[]> verifiedHandler) {
            if(client==null) throw new InvalidOperationException("IPC_EXPECTED_PEER_REQUIRED");
            if (verifiedHandler==null) throw new ArgumentNullException("verifiedHandler");
            if (used) throw new InvalidOperationException("IPC_ALREADY_USED");
            used=true;
            var clock=Stopwatch.StartNew();
            try {
                Wait(Task.Factory.FromAsync(pipe.BeginWaitForConnection,pipe.EndWaitForConnection,null),clock,pipe);
                // Read one fixed byte so Windows can impersonate the named-pipe client.
                byte[] hello=new byte[1]; ReadExact(pipe,hello,clock);
                if (hello[0]!=1) throw new InvalidOperationException("IPC_HELLO_REJECTED");
                client.AssertClient(pipe);
                byte[] request=Read(pipe,clock);
                client.AssertClient(pipe);
                // The handler must parse and bind the request, and fsync any consume,
                // before producing a response. Never precompute a Grant response.
                byte[] response=verifiedHandler(request);
                client.AssertClient(pipe);
                Write(pipe,response,clock);
                client.AssertClient(pipe);
                return request;
            } finally { pipe.Dispose(); }
        }
        // Keep the same first-instance handle idle until a client arrives or the
        // Tray cancels it. No session/approval deadline starts before admission.
        // The connected handshake and session remain bounded. The resolver
        // receives an OS-observed PID, never a PID from a message. Production uses
        // the protected InstalledRelease resolver; transport tests confer no grant.
        public void Serve(Func<int,Peer> resolve,Action<Channel> handler,CancellationToken cancellation) {
            if(used) throw new InvalidOperationException("IPC_ALREADY_USED");
            used=true;
            using(cancellation.Register(() => pipe.Dispose())) {
                try {
                    var pending=Task.Factory.FromAsync(pipe.BeginWaitForConnection,pipe.EndWaitForConnection,null);
                    // Cancellation disposes the handle above, completing this
                    // pending native accept. Never recreate/rebind the listener.
                    pending.GetAwaiter().GetResult();
                    var clock=Stopwatch.StartNew();
                    byte[] hello=new byte[1]; ReadExact(pipe,hello,clock);
                    if(hello[0]!=1) throw new InvalidOperationException("IPC_HELLO_REJECTED");
                    using(var peer=resolve(McpCcNormalSecurity.ObservedClientPid(pipe))) {
                        Action check=() => peer.AssertClient(pipe);
                        check();
                        clock.Restart(); // Closure verification is not the challenge's IO budget.
                        byte[] challenge=RandomBytes(32); Write(pipe,challenge,clock);
                        byte[] reply=Read(pipe,clock);
                        if(reply.Length!=64 || !Equal(challenge,0,reply,0,32)) throw new InvalidOperationException("IPC_CHALLENGE_REJECTED");
                        check();
                        byte[] binding=Hash(reply); Write(pipe,binding,clock);
                        using(var channel=new Channel(pipe,check,binding)) handler(channel);
                    }
                } finally { pipe.Dispose(); }
            }
        }
        public void Dispose() { pipe.Dispose(); }
    }

    static byte[] RandomBytes(int size) { var b=new byte[size]; using(var rng=RandomNumberGenerator.Create()) rng.GetBytes(b); return b; }
    static byte[] Hash(byte[] b) { using(var h=SHA256.Create()) return h.ComputeHash(b); }
    static bool Equal(byte[] a,int ai,byte[] b,int bi,int length) {
        int diff=0; for(int i=0;i<length;i++) diff|=a[ai+i]^b[bi+i]; return diff==0;
    }
    public static Guid OwnerChannel(McpCcNormalNative.Proof proof) {
        byte[] bytes=Hash(Encoding.UTF8.GetBytes("codex-normal-host-v1|"+proof.pid+"|"+proof.startedUtcTicks+"|"+proof.sid+"|"+proof.session));
        var id=new byte[16]; Array.Copy(bytes,id,16); return new Guid(id);
    }
    public sealed class Channel : IDisposable {
        readonly PipeStream pipe; readonly Action check; readonly byte[] binding;
        readonly Stopwatch lifetime=Stopwatch.StartNew();
        readonly long created=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int sent,received; bool disposed;
        internal Channel(PipeStream p,Action verify,byte[] session) { pipe=p;check=verify;binding=(byte[])session.Clone(); }
        public string Binding { get { return BitConverter.ToString(binding).Replace("-","").ToLowerInvariant(); } }
        void Check() {
            if(disposed || lifetime.ElapsedMilliseconds>=120000 || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<created)
                throw new InvalidOperationException("IPC_SESSION_EXPIRED");
            check();
        }
        public void Send(byte[] payload) {
            Check();
            if(payload==null || payload.Length<1 || payload.Length>MaxFrameBytes-44 || sent==Int32.MaxValue)
                throw new InvalidOperationException("IPC_FRAME_REJECTED");
            var frame=new byte[44+payload.Length];
            Array.Copy(BitConverter.GetBytes(++sent),0,frame,0,4);
            Array.Copy(BitConverter.GetBytes(created+120000),0,frame,4,8);
            Array.Copy(binding,0,frame,12,32); Array.Copy(payload,0,frame,44,payload.Length);
            Write(pipe,frame,Stopwatch.StartNew()); Check();
        }
        public byte[] Receive() {
            // An actual NORMAL child has a 30s deadline plus bounded cleanup.
            // Waiting for its observation must not retain the old 5.5s RPC budget.
            Check(); var frame=Read(pipe,Stopwatch.StartNew(),40000); Check();
            long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if(frame.Length<45 || received==Int32.MaxValue || BitConverter.ToInt32(frame,0)!=received+1
                || BitConverter.ToInt64(frame,4)<=now || BitConverter.ToInt64(frame,4)>now+120000
                || !Equal(binding,0,frame,12,32)) throw new InvalidOperationException("IPC_REPLAY_OR_BINDING_REJECTED");
            received++; var payload=new byte[frame.Length-44]; Array.Copy(frame,44,payload,0,payload.Length); return payload;
        }
        public void Dispose() { if(!disposed) { disposed=true;pipe.Dispose();Array.Clear(binding,0,binding.Length); } }
    }
    public static void Connect(Guid name,Peer server,Action<Channel> handler,Peer guardian=null) {
        server.Check();
        var handle=CreateFile(Name(name),ReadWriteSynchronize,0,IntPtr.Zero,3,Overlapped|SqosPresent|Identification,IntPtr.Zero);
        if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error();handle.Dispose();throw new Win32Exception(error); }
        using(var pipe=new NamedPipeClientStream(PipeDirection.InOut,true,true,handle)) {
            Action check=() => { server.AssertServer(pipe); if(guardian!=null) guardian.Check(); }; check(); var clock=Stopwatch.StartNew();
            Wait(pipe.WriteAsync(new byte[]{1},0,1),clock,pipe);
            var challenge=Read(pipe,clock,40000); clock.Restart();
            if(challenge.Length!=32) throw new InvalidOperationException("IPC_CHALLENGE_REJECTED");
            var reply=new byte[64];Array.Copy(challenge,reply,32);Array.Copy(RandomBytes(32),0,reply,32,32);
            Write(pipe,reply,clock);var binding=Read(pipe,clock);var expected=Hash(reply);
            if(binding.Length!=32 || !Equal(binding,0,expected,0,32)) throw new InvalidOperationException("IPC_CHALLENGE_REJECTED");
            check(); using(var channel=new Channel(pipe,check,binding)) handler(channel);
        }
    }

    public static byte[] Exchange(Guid channel, Peer server, byte[] request) {
        if (server==null) throw new ArgumentNullException("server");
        server.Check();
        var clock=Stopwatch.StartNew();
        SafePipeHandle handle=CreateFile(Name(channel),ReadWriteSynchronize,0,IntPtr.Zero,3,
            Overlapped|SqosPresent|Identification,IntPtr.Zero);
        if (handle.IsInvalid) {
            int code=Marshal.GetLastWin32Error(); handle.Dispose();
            var error=new Win32Exception(code); error.Data["operation"]="CreateFile(named-pipe client)"; throw error;
        }
        // CreateFile has already connected this handle; no Connect() or retry follows.
        using(var pipe=new NamedPipeClientStream(PipeDirection.InOut,true,true,handle)) {
            server.AssertServer(pipe); // Before disclosing any protocol data.
            Wait(pipe.WriteAsync(new byte[] {1},0,1),clock,pipe);
            Write(pipe,request,clock);
            byte[] response=Read(pipe,clock);
            server.AssertServer(pipe);
            return response;
        }
    }
}
