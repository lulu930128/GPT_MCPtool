using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

// Actual ephemeral OS transport, current isolated process only. These tests never
// mint NativeCeremony, HostLease, a production transport capability or a Grant.
public static class NormalHostReceiverCheck {
    static int checks;
    public static string TransportStatus="NOT_RUN";
    public static string IdleAdmissionStatus="NOT_RUN";
    public const int IdleAdmissionDelayMilliseconds=125000;
    static Dictionary<string,object> Map(params object[] values) {var r=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)r.Add((string)values[i],values[i+1]);return r;}
    static McpCcNormalPipe.Peer Retain(McpCcNormalNative.Proof p) {return McpCcNormalPipe.Peer.Retain(p.pid,p.sid,p.image,p.session,p.startedUtcTicks,false);}
    static void Expect(Action action,string code) {
        try {action();throw new Exception("EXPECTED_REFUSAL_"+code);}catch(Exception e){if(e.GetBaseException().Message!=code)throw;}checks++;
    }
    static void Session(McpCcNormalNative.Proof proof,int idleMilliseconds=0) {
        Guid name=Guid.NewGuid();
        using(var peer=Retain(proof)) using(var listener=new McpCcNormalPipe.Listener(name,proof.sid)) {
            var serve=Task.Run(() => listener.Serve(pid => {if(pid!=proof.pid)throw new Exception("WRONG_OBSERVED_PID");return Retain(proof);},McpCcNormalHost.Serve,CancellationToken.None));
            if(idleMilliseconds>0) {
                if(serve.Wait(idleMilliseconds))throw new Exception("IDLE_LISTENER_CLOSED_BEFORE_REQUEST");
                checks++;
            }
            McpCcNormalPipe.Connect(name,peer,channel => {
                string session=Guid.NewGuid().ToString("D");
                var initial=Map("contract",McpCcNormalHost.Contract,"session",session,
                    "expiresAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+60000,"operation","preflight");
                channel.Send(McpCcNormalHost.Encode(initial));
                var response=McpCcNormalHost.Decode(channel.Receive());
                McpCcNormalHost.Fields(response,"kind","session","code");
                if((string)response["kind"]!="complete" || (string)response["session"]!=session ||
                    (string)response["code"]!="HOST_READY")throw new Exception("OWNER_AUTHORITY_OPENED");
            });
            if(!serve.Wait(7000))throw new Exception("SESSION_NOT_CLOSED");checks++;
            Expect(() => listener.Serve(pid=>Retain(proof),McpCcNormalHost.Serve,CancellationToken.None),"IPC_ALREADY_USED");
        }
    }
    static void WireRefusal(McpCcNormalNative.Proof proof,bool replay) {
        using(var peer=Retain(proof)) using(var listener=new McpCcNormalPipe.Listener(Guid.NewGuid(),peer)) { /* constructor resource cleanup */ }
        Guid name=Guid.NewGuid();
        using(var peer=Retain(proof)) using(var listener=new McpCcNormalPipe.Listener(name,proof.sid)) {
            var serve=Task.Run(() => {
                try {
                    listener.Serve(pid=>Retain(proof),channel=>{if(replay)channel.Receive();channel.Receive();},CancellationToken.None);
                    throw new Exception("INVALID_WIRE_ACCEPTED");
                }catch(InvalidOperationException e){if(e.Message!="IPC_REPLAY_OR_BINDING_REJECTED")throw;}
            });
            McpCcNormalPipe.Connect(name,peer,channel=>{
                // Corrupt the transport bytes, never reflection into an authority.
                var pipe=(PipeStream)typeof(McpCcNormalPipe.Channel).GetField("pipe",System.Reflection.BindingFlags.Instance|System.Reflection.BindingFlags.NonPublic).GetValue(channel);
                var frame=new byte[45];Array.Copy(BitConverter.GetBytes(1),frame,4);
                Array.Copy(BitConverter.GetBytes(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+10000),0,frame,4,8);
                string hash=channel.Binding;
                for(int i=0;i<32;i++)frame[12+i]=Convert.ToByte(hash.Substring(i*2,2),16);
                if(!replay)frame[12]^=1;frame[44]=1;
                var length=BitConverter.GetBytes(frame.Length);
                pipe.Write(length,0,4);pipe.Write(frame,0,frame.Length);
                if(replay){pipe.Write(length,0,4);pipe.Write(frame,0,frame.Length);}
                if(!serve.Wait(7000))throw new Exception("REPLAY_NOT_REFUSED");
            });checks++;
        }
    }
    static void WrongAcl(McpCcNormalNative.Proof proof) {
        Guid id=Guid.NewGuid();var acl=new PipeSecurity();
        acl.SetSecurityDescriptorBinaryForm(McpCcNormalPipe.Descriptor(proof.sid,proof.sid));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier("S-1-1-0"),PipeAccessRights.ReadData,AccessControlType.Allow));
        using(var server=new NamedPipeServerStream("codex-normal-v1-"+id.ToString("N"),PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,acl))
        using(var peer=Retain(proof)) {
            var wait=server.WaitForConnectionAsync();
            Expect(()=>McpCcNormalPipe.Connect(id,peer,c=>{throw new Exception("BAD_ACL_HANDLER_REACHED");}),"IPC_DACL_REJECTED");
            if(!wait.Wait(7000))throw new Exception("ACL_TEST_NOT_CONNECTED");
        }
    }
    static void CancelIdle(McpCcNormalNative.Proof proof) {
        using(var cancellation=new CancellationTokenSource())
        using(var listener=new McpCcNormalPipe.Listener(Guid.NewGuid(),proof.sid)) {
            var wait=Task.Run(()=>{
                try {listener.Serve(pid=>{throw new Exception("UNEXPECTED_CONNECTION");},c=>{throw new Exception("UNEXPECTED_SESSION");},cancellation.Token);}
                catch(Exception e) {if(!(e.GetBaseException() is ObjectDisposedException) && !(e.GetBaseException() is IOException))throw;}
            });
            if(wait.Wait(100))throw new Exception("IDLE_ACCEPT_ENDED_BEFORE_CANCELLATION");
            cancellation.Cancel();
            if(!wait.Wait(2000))throw new Exception("CANCELLATION_DID_NOT_RELEASE_PIPE");
            checks++;
            Expect(()=>listener.Serve(pid=>Retain(proof),McpCcNormalHost.Serve,CancellationToken.None),"IPC_ALREADY_USED");
        }
    }
    static void StalledHello(McpCcNormalNative.Proof proof) {
        Guid name=Guid.NewGuid();
        using(var listener=new McpCcNormalPipe.Listener(name,proof.sid)) {
            var serve=Task.Run(()=>{
                try {
                    listener.Serve(pid=>{throw new Exception("UNVERIFIED_PEER_REACHED");},
                        channel=>{throw new Exception("UNVERIFIED_SESSION_REACHED");},CancellationToken.None);
                    throw new Exception("STALLED_HELLO_ACCEPTED");
                } catch(Exception e) {
                    if(!(e.GetBaseException() is TimeoutException) || e.GetBaseException().Message!="IPC_DEADLINE")throw;
                }
            });
            using(var client=new NamedPipeClientStream(".","codex-normal-v1-"+name.ToString("N"),
                PipeDirection.InOut,PipeOptions.Asynchronous)) {
                client.Connect(2000);
                // Once connected, a client that sends no hello still expires.
                if(!serve.Wait(8000))throw new Exception("CONNECTED_HANDSHAKE_NOT_BOUNDED");
                checks++;
            }
            Expect(()=>listener.Serve(pid=>Retain(proof),McpCcNormalHost.Serve,CancellationToken.None),"IPC_ALREADY_USED");
        }
    }
    public static int RunIdleAdmission() {
        using(var self=Process.GetCurrentProcess()) {
            var proof=McpCcNormalNative.Inspect(self);
            var token=McpCcNormalSecurity.Observe(self);
            McpCcNormalSecurity.AssertNormal(token,proof.sid,proof.session);
            CancelIdle(proof);
            // Cross the former production 120-second idle deadline using the
            // real OS pipe and clock. Only the fixed, inert preflight is sent.
            Session(proof,IdleAdmissionDelayMilliseconds);
            StalledHello(proof);
            IdleAdmissionStatus="PASS_NATIVE_IDLE_ADMISSION_ONLY";
        }
        return checks;
    }
    public static int Run() {
        var initial=Map("contract",McpCcNormalHost.Contract,"session",Guid.NewGuid().ToString("D"),"expiresAt",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+60000,"operation","preflight");
        if(McpCcNormalHost.ValidateInitial(McpCcNormalHost.Encode(initial))!="preflight")throw new Exception("PREFLIGHT_PARSE_FAILED");checks++;
        initial.Add("review",null);
        Expect(()=>McpCcNormalHost.ValidateInitial(McpCcNormalHost.Encode(initial)),"IPC_FIELDS_REJECTED");
        initial.Remove("review");initial["operation"]="review";
        Expect(()=>McpCcNormalHost.ValidateInitial(McpCcNormalHost.Encode(initial)),"IPC_FIELDS_REJECTED");
        initial["operation"]="execute";
        Expect(()=>McpCcNormalHost.ValidateInitial(McpCcNormalHost.Encode(initial)),"IPC_OPERATION_REJECTED");
        using(var self=Process.GetCurrentProcess()) {
            var proof=McpCcNormalNative.Inspect(self);
            using(var cancellation=new CancellationTokenSource())
            using(var listener=new McpCcNormalPipe.Listener(Guid.NewGuid(),proof.sid)) {
                var wait=Task.Run(()=>{
                    try {listener.Serve(pid=>{throw new Exception("UNEXPECTED_CONNECTION");},c=>{throw new Exception("UNEXPECTED_SESSION");},cancellation.Token);}
                    catch(Exception e) {if(!(e.GetBaseException() is ObjectDisposedException) && !(e.GetBaseException() is IOException))throw;}
                });
                cancellation.Cancel();
                if(!wait.Wait(2000))throw new Exception("CANCELLATION_DID_NOT_RELEASE_PIPE");checks++;
            }
            var token=McpCcNormalSecurity.Observe(self);
            if(token.restricted) {
                Expect(()=>McpCcNormalSecurity.AssertNormal(token,proof.sid,proof.session),"NORMAL_TOKEN_REJECTED");
                Expect(()=>Retain(proof),"NORMAL_TOKEN_REJECTED");
                McpCcNormalSecurity.AssertUnchanged(self,token);checks++;
                TransportStatus="BLOCKED_RESTRICTED_TOKEN_POSITIVE_SKIPPED";
                return checks;
            }
            Expect(()=>McpCcNormalPipe.Peer.Retain(proof.pid,proof.sid,proof.image,proof.session,proof.startedUtcTicks+1,false),"IPC_PEER_IDENTITY_REJECTED");
            // Manual positive transport sends ONLY preflight/inert frames. No
            // review snapshot, script, candidate, approval or execution is sent.
            Session(proof);
            WireRefusal(proof,true);WireRefusal(proof,false);WrongAcl(proof);
            TransportStatus="PASS_ISOLATED_OS_TRANSPORT_ONLY";
        }
        return checks;
    }
}
