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

namespace McpCc.WorkspaceLocal {
    // This assembly has no lifecycle or process-launch API. The existing owner
    // publishes a sanitized in-memory sample; IPC never starts a new probe job.
    public static class Contract {
        public const int MaxBytes = 16384, DeadlineMs = 1800;
        public const string PipeName = "mcpcc-workspace-local-v1";
        public static readonly string[] Ids = { "codex_bridge", "omi_search", "japanese_study", "memory_core", "personal_asset_os", "english_study", "listening_audio" };
        public static readonly string[] Actions = { "ensure_running", "repair_connectivity", "restart_core", "reload_runtime", "shutdown_runtime" };
        public static readonly string[] States = { "Ready", "Degraded", "BlockedUpstream", "Stopped", "Unhealthy", "OwnershipMismatch", "OwnershipUnknown", "Misconfigured", "NotInstalled", "UNVERIFIED" };
        internal static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=MaxBytes, RecursionLimit=12 }; }
        public static string Nonce() { byte[] b=new byte[32]; using(var rng=RandomNumberGenerator.Create()) rng.GetBytes(b); return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        public static bool IsRequestId(string value) { return Regex.IsMatch(value,"\\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\z"); }
        public static bool Has(string[] values, string value) { return Array.IndexOf(values,value)>=0; }
        // Restricted flat JSON: only unescaped ASCII strings. Reject duplicate,
        // unknown, escaped and case-variant keys before the JSON deserializer.
        public static Dictionary<string,string> Request(string json, string challenge) {
            if (json==null || Encoding.UTF8.GetByteCount(json)>2048 ||
                !Regex.IsMatch(json,@"\A\s*\{\s*""[A-Za-z]+""\s*:\s*""[a-zA-Z0-9_-]*""(?:\s*,\s*""[A-Za-z]+""\s*:\s*""[a-zA-Z0-9_-]*"")*\s*\}\s*\z")) throw new InvalidOperationException("INVALID_REQUEST");
            var result=new Dictionary<string,string>(StringComparer.Ordinal);
            foreach(Match m in Regex.Matches(json,@"""([A-Za-z]+)""\s*:\s*""([a-zA-Z0-9_-]*)""")) result.Add(m.Groups[1].Value,m.Groups[2].Value);
            string[] keys={"v","nonce","challenge","operation","componentId","action","requestId","confirmation"};
            if(result.Count!=keys.Length) throw new InvalidOperationException("INVALID_REQUEST");
            foreach(string key in keys) if(!result.ContainsKey(key)) throw new InvalidOperationException("INVALID_REQUEST");
            if(result["v"]!="1" || !Regex.IsMatch(result["nonce"],"\\A[0-9a-f]{64}\\z") ||
               result["challenge"]!=challenge || !Regex.IsMatch(challenge,"\\A[0-9a-f]{64}\\z")) throw new InvalidOperationException("REPLAY_OR_VERSION_REJECTED");
            string op=result["operation"], id=result["componentId"], action=result["action"], request=result["requestId"];
            if(op=="restart" && Has(Ids,id) && action=="reload_runtime" && result["confirmation"]=="interrupt_current_requests" && IsRequestId(request)) return result;
            if(result["confirmation"]!="") throw new InvalidOperationException("INVALID_REQUEST");
            if(op=="status" && (id=="" || Has(Ids,id)) && action=="" && request=="") return result;
            if(op=="diagnostics" && Has(Ids,id) && action=="" && request=="") return result;
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
    // Separate DTO: never add fields to the legacy Row or receipt wire contract.
    public sealed class ProbeDetail {
        public string role {get;set;}
        public bool? success {get;set;}
        public bool? tcpOpen {get;set;}
        public bool ownerKnown {get;set;}
        public int? pid {get;set;}
        public bool? matchesExpected {get;set;}
        public string runtimeBuildId {get;set;}
        public int? activeJobs {get;set;}
        public int? pendingApproval {get;set;}
        public string controller {get;set;}
    }
    public sealed class Detail {
        public string componentId {get;set;}
        public string status {get;set;}
        public string localStatus {get;set;}
        public string observedAt {get;set;}
        public string readinessScope {get;set;}
        public ProbeDetail[] probes {get;set;}
        internal Detail Copy(Row row) {
            if(componentId!=row.componentId || status!=row.status || observedAt!=row.observedAt ||
               !Contract.Has(Contract.States,localStatus) || !Contract.Has(new [] {"none","local","remote_registration","end_to_end","UNVERIFIED"},readinessScope) ||
               probes==null || probes.Length>8) throw new InvalidOperationException("DIAGNOSTICS_INVALID");
            var copy=new List<ProbeDetail>();
            foreach(var p in probes) {
                if(p==null || !Contract.Has(new [] {"core","connectivity","dependency"},p.role) ||
                   (!p.ownerKnown && (p.pid!=null || p.matchesExpected!=null)) || (p.ownerKnown && (!p.pid.HasValue || p.pid.Value<=0)) ||
                   (p.runtimeBuildId!=null && !Regex.IsMatch(p.runtimeBuildId,"\\A[a-fA-F0-9]{7,64}\\z")) ||
                   (p.controller!=null && !Contract.Has(new [] {"ready","idle","starting","unavailable"},p.controller)) ||
                   p.activeJobs.HasValue!=p.pendingApproval.HasValue || p.activeJobs<0 || p.pendingApproval<0 ||
                   (p.success!=true && (p.runtimeBuildId!=null || p.activeJobs!=null || p.controller!=null)) ||
                   ((p.activeJobs!=null || p.controller!=null) && (componentId!="codex_bridge" || p.role!="core"))) throw new InvalidOperationException("DIAGNOSTICS_INVALID");
                copy.Add(new ProbeDetail {role=p.role,success=p.success,tcpOpen=p.tcpOpen,ownerKnown=p.ownerKnown,pid=p.pid,matchesExpected=p.matchesExpected,
                    runtimeBuildId=p.runtimeBuildId,activeJobs=p.activeJobs,pendingApproval=p.pendingApproval,controller=p.controller});
            }
            return new Detail {componentId=componentId,status=status,localStatus=localStatus,observedAt=row.observedAt,readinessScope=readinessScope,probes=copy.ToArray()};
        }
    }
    public sealed class Snapshot {
        readonly Row[] rows;
        readonly Dictionary<string,Detail> details=new Dictionary<string,Detail>(StringComparer.Ordinal);
        public Snapshot(Row[] source) : this(source,new Detail[0]) { }
        public Snapshot(Row[] source,Detail[] enrichment) {
            if(source==null || source.Length!=7) throw new InvalidOperationException("SNAPSHOT_INVALID");
            var ids=new HashSet<string>(StringComparer.Ordinal); var copy=new List<Row>();
            foreach(Row r in source) {
                DateTimeOffset date;
                if(r==null || !Contract.Has(Contract.Ids,r.componentId) || !ids.Add(r.componentId) || !Contract.Has(Contract.States,r.status) ||
                    !DateTimeOffset.TryParse(r.observedAt,System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out date) ||
                    r.capabilities==null || r.capabilities.Length>5) throw new InvalidOperationException("SNAPSHOT_INVALID");
                var caps=new HashSet<string>(StringComparer.Ordinal);
                foreach(string a in r.capabilities) if(!Contract.Has(Contract.Actions,a) || !caps.Add(a)) throw new InvalidOperationException("SNAPSHOT_INVALID");
                copy.Add(new Row { componentId=r.componentId,status=r.status,observedAt=date.ToString("o"),capabilities=(string[])r.capabilities.Clone() });
            }
            rows=copy.ToArray();
            if(enrichment==null || enrichment.Length>7) throw new InvalidOperationException("DIAGNOSTICS_INVALID");
            foreach(var d in enrichment) {
                if(d==null || !Contract.Has(Contract.Ids,d.componentId) || details.ContainsKey(d.componentId)) throw new InvalidOperationException("DIAGNOSTICS_INVALID");
                // Compare input timestamps before normalizing to preserve existing Row handling.
                Row original=Array.Find(source,row=>row.componentId==d.componentId);
                Detail safe=d.Copy(original);safe.observedAt=Array.Find(rows,row=>row.componentId==d.componentId).observedAt;
                details.Add(d.componentId,safe);
            }
        }
        internal static string DiagnosticsReply(Dictionary<string,string> r,Detail detail,string code,string observedAt) {
            return Contract.Json().Serialize(new {v="1",nonce=r["nonce"],operation="diagnostics",componentId=r["componentId"],diagnosticsVersion="1",code=code,observedAt=observedAt,detail=detail});
        }
        internal string Reply(Dictionary<string,string> r) {
            bool fresh=true;
            foreach(Row row in rows) if(r["componentId"]=="" || row.componentId==r["componentId"]) {
                double age=(DateTimeOffset.UtcNow-DateTimeOffset.Parse(row.observedAt)).TotalSeconds;
                if(age>90 || age< -1) fresh=false;
            }
            if(r["operation"]=="diagnostics") {
                Detail detail;details.TryGetValue(r["componentId"],out detail);
                string observed=Array.Find(rows,row=>row.componentId==r["componentId"]).observedAt;
                return DiagnosticsReply(r,fresh ? detail : null,!fresh ? "SNAPSHOT_STALE" : detail==null ? "SNAPSHOT_UNAVAILABLE" : "DIAGNOSTICS_OBSERVATION",observed);
            }
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
        [DllImport("kernel32.dll",SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CancelIoEx(SafePipeHandle pipe,IntPtr overlapped);
    }

    internal static class Frame {
        internal static void Wait(Task task,Stopwatch clock,PipeStream pipe) {
            int remaining=Contract.DeadlineMs-(int)clock.ElapsedMilliseconds;
            try { if(remaining<=0 || !task.Wait(remaining)) throw new TimeoutException("IPC_TIMEOUT");task.GetAwaiter().GetResult(); }
            catch {
                // Disconnect does not cancel overlapped IO. Settle it before reusing
                // this instance, otherwise the old read may consume the next frame.
                if(!task.IsCompleted) {
                    try { Native.CancelIoEx(pipe.SafePipeHandle,IntPtr.Zero);task.Wait(Contract.DeadlineMs); }
                    catch { /* Only completion state matters; never expose IO errors. */ }
                    if(!task.IsCompleted) pipe.Dispose(); // fail closed, never re-accept
                }
                // Observe a fault even when the original deadline had already expired.
                if(task.IsFaulted) { var observed=task.Exception; }
                throw;
            }
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

    public sealed class RestartRequest {
        public string requestId {get;set;}
        public string componentId {get;set;}
        public string action {get;set;}
        public string confirmation {get;set;}
    }
    public sealed class Receipt {
        public string requestId {get;set;}
        public string componentId {get;set;}
        public string action {get;set;}
        public string confirmation {get;set;}
        public string outcome {get;set;}
        public string createdAt {get;set;}
        public string updatedAt {get;set;}
    }
    // Private CC evidence, deliberately separate from the frozen IPC Receipt DTO.
    public sealed class RefusalDiagnostic {
        public string requestId {get;set;}
        public string componentId {get;set;}
        public string action {get;set;}
        public string reason {get;set;}
        public string observedAt {get;set;}
        public static bool IsReason(string value) {
            return value=="ACTIVE_WORK_PRESENT" || value=="OWNERSHIP_MISMATCH" || value=="OWNERSHIP_UNKNOWN" || value=="ACTIVE_STATE_UNKNOWN";
        }
    }
    internal sealed class ReceiptStore {
        readonly string root;
        readonly string diagnosticRoot;
        internal ReceiptStore(string runtimeRoot) {
            root=Path.Combine(Path.GetFullPath(runtimeRoot),"workspace-local-receipts");
            diagnosticRoot=Path.Combine(Path.GetFullPath(runtimeRoot),"workspace-local-diagnostics");
        }
        string FilePath(string id) {
            if(!Contract.IsRequestId(id)) throw new InvalidOperationException("INVALID_REQUEST");
            if(Directory.Exists(root) && (File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            return Path.Combine(root,id.ToLowerInvariant()+".json");
        }
        internal Receipt Read(string id) {
            string path=FilePath(id);Receipt r;
            try {
                if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete)) {
                    if(file.Length>4096) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                    using(var reader=new StreamReader(file,new UTF8Encoding(false,true))) r=Contract.Json().Deserialize<Receipt>(reader.ReadToEnd());
                }
            } catch(FileNotFoundException) { return null; } catch(DirectoryNotFoundException) { return null; }
            DateTimeOffset created,updated;
            if(r==null || !String.Equals(r.requestId,id,StringComparison.OrdinalIgnoreCase) || !Contract.Has(Contract.Ids,r.componentId) || r.action!="reload_runtime" || r.confirmation!="interrupt_current_requests" ||
               (r.outcome!="UNKNOWN" && r.outcome!="COMPLETED") || !DateTimeOffset.TryParse(r.createdAt,out created) || !DateTimeOffset.TryParse(r.updatedAt,out updated)) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            return r;
        }
        static void WriteNew(string path,object value) {
            byte[] bytes=Encoding.UTF8.GetBytes(Contract.Json().Serialize(value));
            using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {file.Write(bytes,0,bytes.Length);file.Flush(true);}
        }
        internal Receipt Reserve(string id, string componentId) {
            if(!Contract.Has(Contract.Ids,componentId)) throw new InvalidOperationException("INVALID_REQUEST");
            string path=FilePath(id);Directory.CreateDirectory(root);
            // Bounded, no automatic eviction: dropping old keys would permit replay.
            int count=0;foreach(string file in Directory.EnumerateFiles(root)) if(++count>=256) throw new InvalidOperationException("RECEIPT_CAPACITY");
            string now=DateTimeOffset.UtcNow.ToString("o");
            var r=new Receipt {requestId=id.ToLowerInvariant(),componentId=componentId,action="reload_runtime",confirmation="interrupt_current_requests",outcome="UNKNOWN",createdAt=now,updatedAt=now};
            WriteNew(path,r);return r;
        }
        internal void Complete(string id,string outcome) {
            if(outcome!="COMPLETED" && outcome!="UNKNOWN") throw new InvalidOperationException("INVALID_OUTCOME");
            var r=Read(id);if(r==null) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            r.outcome=outcome;r.updatedAt=DateTimeOffset.UtcNow.ToString("o");
            string path=FilePath(id), temp=path+".pending";
            WriteNew(temp,r);File.Replace(temp,path,null);
        }
        internal void RecordRefusal(string id,string reason) {
            if(!RefusalDiagnostic.IsReason(reason)) throw new InvalidOperationException("INVALID_REFUSAL_REASON");
            var r=Read(id);
            if(r==null || r.outcome!="UNKNOWN") throw new InvalidOperationException("REFUSAL_DIAGNOSTIC_UNAVAILABLE");
            if(Directory.Exists(diagnosticRoot) && (File.GetAttributes(diagnosticRoot)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("REFUSAL_DIAGNOSTIC_UNAVAILABLE");
            Directory.CreateDirectory(diagnosticRoot);
            if((File.GetAttributes(diagnosticRoot)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("REFUSAL_DIAGNOSTIC_UNAVAILABLE");
            string path=Path.Combine(diagnosticRoot,r.requestId.ToLowerInvariant()+".json"),temp=path+".pending";
            // One immutable sidecar per reserved UUID; no overwrite or history rewrite.
            // CreateNew + flush + same-directory rename never publishes partial JSON.
            WriteNew(temp,new RefusalDiagnostic {requestId=r.requestId,componentId=r.componentId,action=r.action,reason=reason,observedAt=DateTimeOffset.UtcNow.ToString("o")});
            try { File.Move(temp,path); }
            finally { File.Delete(temp); }
        }
    }

    // No installed release, human identity ceremony or lifecycle implementation.
    // Only the existing tray composition opens the production name, after its mutex.
    public sealed class Owner : IDisposable {
        readonly object sync=new object();
        readonly NamedPipeServerStream pipe;
        Snapshot snapshot;
        Task worker;
        volatile bool stopped;
        bool closing;
        readonly ReceiptStore receipts;
        RestartRequest pending;
        string activeRequest;
        long acceptedTicks;
        public static Owner Open(string runtimeRoot) { return new Owner(Contract.PipeName, runtimeRoot); }
        internal Owner(string name, string runtimeRoot) {
            receipts=new ReceiptStore(runtimeRoot);
            using(var identity=WindowsIdentity.GetCurrent()) {
                var security=new RawSecurityDescriptor("O:"+identity.User.Value+"D:P(A;;0x0012019f;;;"+identity.User.Value+")");
                byte[] bytes=new byte[security.BinaryLength];security.GetBinaryForm(bytes,0);
                var pinned=GCHandle.Alloc(bytes,GCHandleType.Pinned);SafePipeHandle handle=null;
                try {
                    var attributes=new Native.SecurityAttributes {length=Marshal.SizeOf(typeof(Native.SecurityAttributes)),descriptor=pinned.AddrOfPinnedObject(),inherit=false};
                    // First instance, overlapped, reject remote clients. Keep the handle
                    // across exchanges; never release/rebind the name between requests.
                    handle=Native.CreateNamedPipe(@"\\.\pipe\"+name,3|0x00080000|0x40000000,8,1,Contract.MaxBytes+4,Contract.MaxBytes+4,Contract.DeadlineMs,ref attributes);
                    if(handle.IsInvalid) throw new InvalidOperationException("PIPE_BIND_REJECTED");
                    pipe=new NamedPipeServerStream(PipeDirection.InOut,true,false,handle);handle=null;
                } finally { if(handle!=null) handle.Dispose();pinned.Free(); }
            }
        }
        public void Publish(Snapshot sample) { lock(sync) snapshot=sample; }
        public void Start() { lock(sync) { if(worker!=null || stopped) throw new InvalidOperationException("ALREADY_STARTED");worker=Task.Run((Action)Loop); } }
        public RestartRequest TakePending() { return TakePending(Stopwatch.GetTimestamp()); }
        internal RestartRequest TakePending(long now) {
            lock(sync) {
                if(pending!=null && (now-acceptedTicks)/(double)Stopwatch.Frequency>30) {
                    pending=null;activeRequest=null;return null;
                }
                var value=pending;pending=null;return value;
            }
        }
        public void Complete(string requestId,string outcome) { lock(sync) { try { receipts.Complete(requestId,outcome); } finally { activeRequest=null; } } }
        public void CompleteRefusal(string requestId,string reason) {
            lock(sync) {
                if(pending!=null || !String.Equals(activeRequest,requestId,StringComparison.OrdinalIgnoreCase) || activeRequest==null)
                    throw new InvalidOperationException("ACTIVE_REQUEST_REQUIRED");
                if(!RefusalDiagnostic.IsReason(reason)) throw new InvalidOperationException("INVALID_REFUSAL_REASON");
                try { receipts.Complete(requestId,"UNKNOWN");receipts.RecordRefusal(requestId,reason); }
                finally { activeRequest=null; }
            }
        }
        public bool HasActiveRequest { get { lock(sync) return activeRequest!=null; } }
        public bool TryBeginShutdown() {
            lock(sync) {
                closing=true;return activeRequest==null;
            }
        }
        internal string Dispatch(Dictionary<string,string> request) {
            lock(sync) {
                Receipt receipt=null;string code;
                if(request["operation"]=="receipt") {
                    receipt=receipts.Read(request["requestId"]);code=receipt==null ? "RECEIPT_NOT_FOUND" : "RECEIPT_OBSERVED";
                } else {
                    receipt=receipts.Read(request["requestId"]);
                    if(receipt!=null) {
                        code=receipt.componentId==request["componentId"] && receipt.action==request["action"] && receipt.confirmation==request["confirmation"] ? "REQUEST_REPLAY" : "REQUEST_CONFLICT";
                        if(code=="REQUEST_CONFLICT") receipt=null;
                    }
                    else if(closing) { code="OWNER_CLOSING"; }
                    else if(activeRequest!=null) { code="ACTION_BUSY"; }
                    else {
                        // Persist UNKNOWN before making work visible to the tray. Crash or
                        // timeout never authorizes re-enqueue with the same requestId.
                        receipt=receipts.Reserve(request["requestId"],request["componentId"]);
                        activeRequest=receipt.requestId;
                        acceptedTicks=Stopwatch.GetTimestamp();
                        pending=new RestartRequest {requestId=receipt.requestId,componentId=receipt.componentId,action=receipt.action,confirmation=receipt.confirmation};
                        code="ACTION_ACCEPTED";
                    }
                }
                return Contract.Json().Serialize(new {v="1",nonce=request["nonce"],operation=request["operation"],componentId=request["componentId"],action=request["action"],requestId=request["requestId"],code=code,
                    components=new Row[0],supported=(object)null,mutationEnabled=true,allowed=false,executable=false,
                    found=code=="REQUEST_CONFLICT" || code=="OWNER_CLOSING" ? (bool?)null : receipt!=null,completed=receipt==null || receipt.outcome=="UNKNOWN" ? (bool?)null : true,receipt=receipt});
            }
        }
        public bool Running { get { return worker!=null && !worker.IsCompleted && !stopped; } }
        string SafeDispatch(Dictionary<string,string> request) {
            try { return Dispatch(request); }
            catch(Exception error) {
                string code=error.Message=="RECEIPT_CAPACITY" ? "RECEIPT_CAPACITY" : "RECEIPT_UNAVAILABLE";
                return Contract.Json().Serialize(new {v="1",nonce=request["nonce"],operation=request["operation"],componentId=request["componentId"],action=request["action"],requestId=request["requestId"],code=code,
                    components=new Row[0],supported=(object)null,mutationEnabled=true,allowed=false,executable=false,found=(object)null,completed=(object)null,receipt=(object)null});
            }
        }
        void Loop() {
            try {
                while(!stopped) {
                    bool connected=false;
                    try {
                        pipe.WaitForConnection();connected=true;var clock=Stopwatch.StartNew();
                        string challenge=Contract.Nonce();Frame.Write(pipe,challenge,clock);
                        var request=Contract.Request(Frame.Read(pipe,clock),challenge);
                        Snapshot sample;lock(sync) sample=snapshot;
                        string reply=(request["operation"]=="restart" || request["operation"]=="receipt") ? SafeDispatch(request) : sample==null && request["operation"]=="diagnostics" ? Snapshot.DiagnosticsReply(request,null,"SNAPSHOT_UNAVAILABLE",null) : sample==null ? Contract.Json().Serialize(new {
                            v="1",nonce=request["nonce"],operation=request["operation"],componentId=request["componentId"],action=request["action"],requestId=request["requestId"],
                            code="SNAPSHOT_UNAVAILABLE",components=new Row[0],supported=(object)null,mutationEnabled=false,allowed=false,executable=false,found=(object)null,completed=(object)null,receipt=(object)null
                        }) : sample.Reply(request);
                        Frame.Write(pipe,reply,clock);
                        // Wait for the client to consume/close before Disconnect can
                        // discard buffered response bytes. The same deadline applies.
                        Frame.Wait(pipe.ReadAsync(new byte[1],0,1),clock,pipe);
                    } catch { if(!connected) stopped=true; /* No accept-failure spin. */ }
                    finally {
                        // EOF/broken clients set IsConnected=false, but the native
                        // instance STILL needs Disconnect before WaitForConnection.
                        // Only this boundary disconnects, after Frame has settled IO.
                        if(connected && !stopped) {
                            try { pipe.Disconnect(); }
                            catch { stopped=true; } // no faulted task or silent zombie handle
                        }
                    }
                }
            } finally { stopped=true;pipe.Dispose(); }
        }
        public void Dispose() {
            stopped=true;
            try { Native.CancelIoEx(pipe.SafePipeHandle,IntPtr.Zero); } catch { }
            pipe.Dispose();
            if(worker!=null) { try { worker.Wait(Contract.DeadlineMs+100); } catch { } }
        }
    }
}
