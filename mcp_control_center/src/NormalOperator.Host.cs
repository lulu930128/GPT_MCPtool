using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Diagnostics;

// Fixed RPC and owner composition only. No Journal, alternate UI, password input,
// service, lifecycle controller or serializable authority. Execution requires the authenticated DIRECT request on the retained channel.
public static class McpCcNormalHost {
    public const string Contract="powershell-host-rpc-v1";
    static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
    static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=131028,RecursionLimit=24 }; }
    public static Dictionary<string,object> Object(object value) {
        var result=value as Dictionary<string,object>;
        if(result==null) throw new InvalidOperationException("IPC_OBJECT_REQUIRED"); return result;
    }
    public static Dictionary<string,object> Decode(byte[] bytes) {
        if(bytes==null || bytes.Length<1 || bytes.Length>131028) throw new InvalidOperationException("IPC_FRAME_REJECTED");
        return Object(Json().DeserializeObject(Utf8.GetString(bytes)));
    }
    public static byte[] Encode(object value) {
        var bytes=Utf8.GetBytes(Json().Serialize(value));
        if(bytes.Length>131028) throw new InvalidOperationException("IPC_FRAME_REJECTED");return bytes;
    }
    static Dictionary<string,object> Map(params object[] values) {
        var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2) result.Add((string)values[i],values[i+1]);return result;
    }
    public static void Fields(Dictionary<string,object> obj,params string[] fields) {
        if(obj.Count!=fields.Length) throw new InvalidOperationException("IPC_FIELDS_REJECTED");
        foreach(var f in fields) if(!obj.ContainsKey(f)) throw new InvalidOperationException("IPC_FIELDS_REJECTED");
    }
    static string Text(Dictionary<string,object> obj,string name) {
        object v;if(!obj.TryGetValue(name,out v) || !(v is string)) throw new InvalidOperationException("IPC_FIELD_REJECTED"); return (string)v;
    }
    static long Number(Dictionary<string,object> obj,string name) {
        object v;if(!obj.TryGetValue(name,out v) || (!(v is int) && !(v is long))) throw new InvalidOperationException("IPC_FIELD_REJECTED");return Convert.ToInt64(v);
    }
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static void Id(string v) { Guid g;if(!Guid.TryParseExact(v,"D",out g) || g==Guid.Empty) throw new InvalidOperationException("IPC_ID_REJECTED"); }
    static void Hash(string v) { if(!System.Text.RegularExpressions.Regex.IsMatch(v,"\\A[a-f0-9]{64}\\z")) throw new InvalidOperationException("IPC_HASH_REJECTED"); }
    static Dictionary<string,object> Init(Dictionary<string,object> value) {
        string operation=Text(value,"operation");
        if(operation=="preflight") Fields(value,"contract","session","expiresAt","operation");
        else if(operation=="review") Fields(value,"contract","session","expiresAt","operation","review");
        else throw new InvalidOperationException("IPC_OPERATION_REJECTED");
        if(Text(value,"contract")!=Contract || Number(value,"expiresAt")<=Now() || Number(value,"expiresAt")>Now()+120000)
            throw new InvalidOperationException("IPC_SESSION_REJECTED");
        Id(Text(value,"session"));if(operation=="preflight") return null;
        var review=Object(value["review"]);Fields(review,"requestId","digest");
        Id(Text(review,"requestId"));Hash(Text(review,"digest"));return review;
    }
    // Pure parser check, not a peer verifier or authority factory.
    public static string ValidateInitial(byte[] bytes) { var value=Decode(bytes);Init(value);return Text(value,"operation"); }
    // Verify exact UTF-8 journal bytes, not a cross-language reserialization. This
    // preserves CRLF/Unicode/args/risk/cwd/source and the existing digest contract.
    public static Dictionary<string,object> ValidateSnapshot(Dictionary<string,object> snapshot,Dictionary<string,object> review) {
        Fields(snapshot,"requestJson","digest","bootId","policy","policyDigest","hostApproval");
        var bytes=Utf8.GetBytes(Text(snapshot,"requestJson"));
        if(McpCcNormalExecution.Sha256(bytes)!=Text(review,"digest") || Text(snapshot,"digest")!=Text(review,"digest"))
            throw new InvalidOperationException("DIGEST_MISMATCH");
        var request=Decode(bytes);
        if(Text(request,"requestId")!=Text(review,"requestId") || Number(request,"expiresAt")<=Now()
            || Number(request,"createdAt")>Now() || Text(request,"scriptEncoding")!="UTF8_EXACT"
            || McpCcNormalExecution.Sha256(Utf8.GetBytes(Text(request,"scriptSnapshot")))!=Text(request,"scriptSha256"))
            throw new InvalidOperationException("HOST_REQUEST_MISMATCH");
        if(Text(request,"executionMode")=="ADMIN") throw new InvalidOperationException("BLOCKED_AWAITING_LOCAL_UAC");
        if(Text(request,"executionMode")!="NORMAL") throw new InvalidOperationException("HOST_REQUEST_MISMATCH");
        if(Text(request,"origin")=="CODEX_DERIVED") throw new InvalidOperationException("FAILURE_ATTRIBUTION_UNVERIFIED");
        if(Text(request,"origin")!="DIRECT") throw new InvalidOperationException("HOST_REQUEST_MISMATCH");
        Id(Text(snapshot,"bootId"));Hash(Text(snapshot,"policyDigest"));
        return request;
    }
    // Independently OS-observed by both the Host and its retained native client.
    // These audit fields never create authority when supplied as caller JSON.
    static Dictionary<string,object> NativeIdentity(Process process) {
        var proof=McpCcNormalNative.Inspect(process);
        var token=McpCcNormalSecurity.Observe(process);
        McpCcNormalSecurity.AssertNormal(token,proof.sid,proof.session);
        if(proof.inAnyJob) throw new InvalidOperationException("OWNER_IN_JOB");
        string imageHash;
        using(var file=File.OpenRead(proof.image)) using(var hash=System.Security.Cryptography.SHA256.Create())
            imageHash=BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();
        McpCcNormalSecurity.AssertUnchanged(process,token);
        string host=McpCcNormalPipe.OwnerChannel(proof).ToString("D");
        return Map("hostId",host,"instanceId",host,"sid",token.sid,"logonId",token.logonId,
            "pid",proof.pid,"processStartedAt",(proof.startedUtcTicks-621355968000000000L)/10000,
            "imageSha256",imageHash,"tokenId",token.tokenId,"integrity","MEDIUM");
    }
    internal sealed class DirectRequestAuthority {
        internal readonly Dictionary<string,object> request;
        readonly Dictionary<string,object> peer;
        readonly string binding;
        string packetHash;
        bool used;
        DirectRequestAuthority(Dictionary<string,object> r,Dictionary<string,object> p,string b) {
            request=r;peer=p;binding=b;
        }
        internal Dictionary<string,object> Observation() {
            return Map("source","WINDOWS_HOST_PEER","observationId",Guid.NewGuid().ToString("D"),
                "channelBinding",binding,"observedAt",Now(),"peer",peer);
        }
        internal static DirectRequestAuthority Require(Dictionary<string,object> snapshot,Dictionary<string,object> review,McpCcNormalPipe.Channel channel) {
            var source=ValidateSnapshot(snapshot,review);
            var policy=Object(snapshot["policy"]);
            if(Number(policy,"timeoutMs")!=McpCcNormalExecution.TimeoutMs || policy["outputLimitBytes"]!=null || Text(policy,"authorization")!="AUTHENTICATED_DIRECT_REQUEST"
                || Text(policy,"executable")!=@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                || Text(policy,"descendantPolicy")!="OWNED_JOB_KILL_ON_CLOSE") throw new InvalidOperationException("NORMAL_POLICY_REJECTED");
            Dictionary<string,object> peer;
            using(var self=Process.GetCurrentProcess()) peer=NativeIdentity(self);
            long now=Now();
            if(now+120000>Number(source,"expiresAt")) throw new InvalidOperationException("TTL_EXPIRED");
            var admission=Map("source","WINDOWS_HOST_PEER","observationId",Guid.NewGuid().ToString("D"),
                "channelBinding",channel.Binding,"observedAt",now,"peer",peer);
            var r=Map("version",2,"evidence","PRODUCTION","policy","powershell-approval-production-v1",
                "requestId",Guid.NewGuid().ToString("D"),"receiptId",Guid.NewGuid().ToString("D"),
                "idempotencyKey",Guid.NewGuid().ToString("D"),"bootId",snapshot["bootId"],"origin","DIRECT");
            foreach(string f in new[]{"projectId","executionMode","target","scriptSnapshot","scriptSha256","scriptEncoding","cwd","args","sideEffects","risk"}) r.Add(f,source[f]);
            r.Add("environmentPolicyDigest",snapshot["policyDigest"]);
            r.Add("createdAt",now);r.Add("ttlMs",120000);r.Add("expiresAt",now+120000);r.Add("nonce",Guid.NewGuid().ToString("D"));
            r.Add("sourceReview",review);
            r.Add("approvalIdentity",Map("authority",peer,"subjectSid",peer["sid"],"ceremonyId",Guid.NewGuid().ToString("D"),
                "interface","REMOTE_MCP_REQUEST","authentication","AUTHENTICATED_DIRECT_REQUEST"));
            r.Add("executorIdentity",peer);r.Add("admission",admission);
            return new DirectRequestAuthority(r,peer,channel.Binding);
        }
        internal void BindConsumed(McpCcNormalExecution.Packet packet) {
            if(used || packetHash!=null) throw new InvalidOperationException("REQUEST_ALREADY_BOUND");
            packetHash=McpCcNormalExecution.Sha256(Encode(packet));
        }
        internal void Consume(McpCcNormalExecution.Packet packet) {
            if(used || packetHash==null || packetHash!=McpCcNormalExecution.Sha256(Encode(packet)))
                throw new InvalidOperationException("BLOCKED_CANONICAL_HOST_AUTHORITY_REQUIRED");
            used=true;
        }
    }
    sealed class Rpc {
        readonly McpCcNormalPipe.Channel channel;readonly Dictionary<string,object> init;int sequence;
        internal Rpc(McpCcNormalPipe.Channel c,Dictionary<string,object> i) { channel=c;init=i; }
        internal Dictionary<string,object> Call(string op,object payload) {
            if(Number(init,"expiresAt")<=Now()) throw new InvalidOperationException("TTL_EXPIRED");
            int seq=++sequence;
            channel.Send(Encode(Map("contract",Contract,"session",init["session"],"channelBinding",channel.Binding,
                "sequence",seq,"expiresAt",init["expiresAt"],"message",Map("operation",op,"payload",payload))));
            var response=Decode(channel.Receive());
            Fields(response,"contract","session","sequence",response.ContainsKey("error")?"error":"result");
            if(Text(response,"contract")!=Contract || Text(response,"session")!=Text(init,"session") || Number(response,"sequence")!=seq)
                throw new InvalidOperationException("IPC_RESPONSE_REJECTED");
            if(response.ContainsKey("error")) throw new InvalidOperationException("CANONICAL_REQUEST_REFUSED");
            return Object(response["result"]);
        }
    }
    public static void Serve(McpCcNormalPipe.Channel channel) {
        var initial=Decode(channel.Receive());var review=Init(initial);var rpc=new Rpc(channel,initial);
        string code;
        try {
            if(review==null) {
                channel.Send(Encode(Map("kind","complete","session",initial["session"],"code","HOST_READY")));return;
            }
            var snapshot=rpc.Call("prepare",review);ValidateSnapshot(snapshot,review);
            var ceremony=DirectRequestAuthority.Require(snapshot,review,channel);
            code=Dispatch(rpc,ceremony);
        } catch(InvalidOperationException e) {
            if(e.Message!="BLOCKED_PLATFORM_CAPABILITY" && e.Message!="BLOCKED_AWAITING_LOCAL_UAC" && e.Message!="FAILURE_ATTRIBUTION_UNVERIFIED") throw;
            code=e.Message;
        }
        channel.Send(Encode(Map("kind","complete","session",initial["session"],"code",code)));
    }
    static string Dispatch(Rpc rpc,DirectRequestAuthority ceremony) {
        // The only route to execution: receiver -> canonical admit/decide/claim ->
        // native kernel -> canonical ingest. The per-request authority and HostLease
        // remain private capabilities of this authenticated installed Host.
        // No overload accepts a boolean/JSON authority and no alternate dispatcher.
        if(ceremony==null) throw new InvalidOperationException("BLOCKED_PLATFORM_CAPABILITY");
        var admitted=rpc.Call("admit",ceremony.request);
        var request=Object(admitted["request"]);
        foreach(string field in new[]{"requestId","sourceReview","scriptSnapshot","scriptSha256","scriptEncoding","args","cwd","target","risk","sideEffects","expiresAt","executorIdentity"})
            if(McpCcNormalExecution.Sha256(Encode(request[field]))!=McpCcNormalExecution.Sha256(Encode(ceremony.request[field])))
                throw new InvalidOperationException("HOST_REQUEST_MISMATCH");
        string id=Text(request,"requestId"),digest=Text(admitted,"digest");
        // The authenticated DIRECT MCP request is the authorization source.
        // Record it honestly; no local-human confirmation is asserted.
        rpc.Call("decide",Map("requestId",id,"digest",digest,"decision","APPROVED","observation",ceremony.Observation()));
        // Lost claim response never reaches Execute and is never retried. Node
        // marks any successful durable consume UNKNOWN when its channel closes.
        var consumed=rpc.Call("claim",Map("requestId",id,"digest",digest,"observation",ceremony.Observation()));
        try {
            var grant=Object(consumed["grant"]);var consumption=Object(consumed["consumption"]);
            if(Text(consumed,"state")!="CONSUMED" || Text(consumed,"digest")!=digest || Text(Object(consumed["request"]),"requestId")!=id)
                throw new InvalidOperationException("HOST_REQUEST_MISMATCH");
            var args=(object[])request["args"];var values=new string[args.Length];
            for(int i=0;i<args.Length;i++) values[i]=(string)args[i];
            var packet=new McpCcNormalExecution.Packet { requestId=id,digest=digest,grantId=Text(grant,"grantId"),
                consumptionId=Text(consumption,"consumptionId"),mode=Text(request,"executionMode"),
                script=Text(request,"scriptSnapshot"),scriptSha256=Text(request,"scriptSha256"),cwd=Text(request,"cwd"),args=values,
                expectedSid=Text(Object(request["executorIdentity"]),"sid"),expiresAt=Number(request,"expiresAt"),receiptDeadline=Number(consumption,"receiptDeadline") };
            ceremony.BindConsumed(packet);
            var execution=McpCcNormalExecution.ExecuteAuthorized(packet,ceremony);
            var observed=execution.observation;
            // Executor time is an observation of completion, not the approval time.
            var executor=ceremony.Observation();
            executor["observedAt"]=observed.completedAt;executor["observationId"]=Guid.NewGuid().ToString("D");
            foreach(string stream in new[]{"stdout","stderr"}) {
                string data=(string)execution.output[stream+"Base64"];int offset=0;
                for(int start=0;start<data.Length;start+=16384) {
                    string part=data.Substring(start,Math.Min(16384,data.Length-start));
                    rpc.Call("output",Map("requestId",id,"digest",digest,"stream",stream,"offset",offset,"dataBase64",part));
                    offset+=Convert.FromBase64String(part).Length;
                }
            }
            rpc.Call("ingestNormal",Map("observation",observed,"executor",executor));
            return "RECEIPT_RECORDED";
        } catch {
            // One lowering attempt, never re-claim/re-dispatch. If disconnected,
            // Node receiver close/recovery owns permanent UNKNOWN in the same store.
            try { rpc.Call("deliveryUncertain",Map("requestId",id,"digest",digest)); } catch(IOException) {} catch(InvalidOperationException) {}
            throw;
        }
    }
    static byte[] ReadLine(Stream input) {
        using(var data=new MemoryStream()) {
            var b=new byte[1];var clock=System.Diagnostics.Stopwatch.StartNew();
            while(data.Length<131028) {
                var read=input.ReadAsync(b,0,1);int left=40000-(int)clock.ElapsedMilliseconds;
                if(left<=0 || !read.Wait(left) || read.Result!=1) throw new IOException("IPC_STDIO_CLOSED");
                if(b[0]==10) return data.ToArray();data.WriteByte(b[0]);
            }
        }
        throw new InvalidOperationException("IPC_FRAME_REJECTED");
    }
    static void WriteLine(Stream output,object value) {
        var bytes=Encode(value);var write=output.WriteAsync(bytes,0,bytes.Length);
        if(!write.Wait(5000)) throw new IOException("IPC_STDIO_CLOSED");write.GetAwaiter().GetResult();
        if(!output.WriteAsync(new byte[]{10},0,1).Wait(5000)) throw new IOException("IPC_STDIO_CLOSED");
    }
    public static void Relay(Guid channelName,McpCcNormalPipe.Peer owner,McpCcNormalPipe.Peer bridge) {
        if(bridge==null) throw new InvalidOperationException("BRIDGE_PARENT_REJECTED");
        bridge.Check();
        using(var input=Console.OpenStandardInput()) using(var output=Console.OpenStandardOutput()) {
            var initial=Decode(ReadLine(input));Init(initial);
            McpCcNormalPipe.Connect(channelName,owner,channel => {
                // Only after retained OS peer, DACL and challenge checks. Node's
                // private capability is minted on this owned stdout, not tool JSON.
                Dictionary<string,object> peer;
                using(var host=Process.GetProcessById(owner.Pid)) peer=NativeIdentity(host);
                owner.Check();
                WriteLine(output,Map("kind","channel","session",initial["session"],"binding",channel.Binding,"peer",peer));
                var ack=Decode(ReadLine(input));Fields(ack,"kind","session");
                if(Text(ack,"kind")!="channel-bound" || Text(ack,"session")!=Text(initial,"session")) throw new InvalidOperationException("IPC_RESPONSE_REJECTED");
                channel.Send(Encode(initial));
                while(true) {
                    var message=Decode(channel.Receive());
                    if(message.ContainsKey("kind")) { WriteLine(output,message);return; }
                    if(Text(message,"channelBinding")!=channel.Binding || Text(message,"session")!=Text(initial,"session"))
                        throw new InvalidOperationException("IPC_RESPONSE_REJECTED");
                    WriteLine(output,message);
                    var response=Decode(ReadLine(input));channel.Send(Encode(response));
                }
            },bridge);
        }
    }
}
