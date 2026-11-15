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
    // IPC publishes sanitized metadata. The OMI v3 adapter can launch only the
    // fixed updater from the already running owner; clients cannot launch work.
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
            if(result.ContainsKey("v") && result["v"]=="3") return OmiContract.Request(result,challenge);
            if(result.ContainsKey("v") && result["v"]=="2") return UpdateContract.Request(result,challenge);
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
        [DllImport("kernel32.dll",SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint processId);
        [DllImport("kernel32.dll",SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process,IntPtr job,[MarshalAs(UnmanagedType.Bool)] out bool inJob);
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
    public static class OwnerProbe {
        // Read-only local handshake bound to the exact selected tray instance.
        // An Exit event alone does not prove that its Workspace listener opened.
        public static bool Status(int expectedPid,long expectedTicks) {
            using(var owner=Process.GetProcessById(expectedPid))
            using(var client=new NamedPipeClientStream(".",Contract.PipeName,PipeDirection.InOut,PipeOptions.Asynchronous)) {
                IntPtr retained=owner.Handle;
                if(owner.HasExited || owner.StartTime.ToUniversalTime().Ticks!=expectedTicks) return false;
                client.Connect(Contract.DeadlineMs);uint actual;
                if(!Native.GetNamedPipeServerProcessId(client.SafePipeHandle,out actual) || actual!=(uint)expectedPid) return false;
                var clock=Stopwatch.StartNew();string challenge=Frame.Read(client,clock),nonce=Contract.Nonce();
                var request=new Dictionary<string,string>{{"v","1"},{"nonce",nonce},{"challenge",challenge},{"operation","status"},{"componentId",""},{"action",""},{"requestId",""},{"confirmation",""}};
                Contract.Request(Contract.Json().Serialize(request),challenge);
                Frame.Write(client,Contract.Json().Serialize(request),clock);
                var result=Contract.Json().Deserialize<Dictionary<string,object>>(Frame.Read(client,clock));
                if(!Native.GetNamedPipeServerProcessId(client.SafePipeHandle,out actual) || actual!=(uint)expectedPid || owner.HasExited) return false;
                return result!=null && Convert.ToString(result["v"])=="1" && Convert.ToString(result["nonce"])==nonce && Convert.ToString(result["operation"])=="status" && Convert.ToString(result["code"])=="OWNER_OBSERVATION";
            }
        }
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
            // Keep the same request index for replay; only uncertain requests
            // consume admission capacity. Completed history is never evicted.
            int count=0;foreach(string file in Directory.EnumerateFiles(root,"*.json")) {
                bool uncertain=true;
                try { uncertain=Read(Path.GetFileNameWithoutExtension(file)).outcome=="UNKNOWN"; } catch { }
                if(uncertain && ++count>=256) throw new InvalidOperationException("RECEIPT_CAPACITY");
            }
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

    public static class UpdateContract {
        public static readonly string[] Ids={"codex_bridge","omi_search","japanese_study","memory_core","personal_asset_os","english_study","listening_audio","project_reading","mcp_control_center"};
        public static bool Supported(string id) { return Contract.Has(Ids,id); }
        public static bool Digest(string value) { return value!=null && Regex.IsMatch(value,"\\A[0-9a-f]{64}\\z"); }
        public static Dictionary<string,string> Request(Dictionary<string,string> r,string challenge) {
            string[] keys={"v","nonce","challenge","operation","componentId","action","requestId","confirmation","versionId","expectedSourceDigest","idlePolicy"};
            if(r.Count!=keys.Length) throw new InvalidOperationException("INVALID_REQUEST");
            foreach(string key in keys) if(!r.ContainsKey(key)) throw new InvalidOperationException("INVALID_REQUEST");
            if(!Digest(r["nonce"]) || r["challenge"]!=challenge || !Digest(challenge)) throw new InvalidOperationException("REPLAY_OR_VERSION_REJECTED");
            string op=r["operation"],id=r["componentId"];
            if(op=="update" || op=="update_preview") {
                if(!Contract.Has(Ids,id) || r["action"]!="update_from_source" || !Regex.IsMatch(r["versionId"],"\\A[a-z0-9][a-z0-9_-]{0,47}\\z") || r["idlePolicy"]!="wait_for_idle") throw new InvalidOperationException("INVALID_REQUEST");
                if(op=="update" ? (!Digest(r["expectedSourceDigest"]) || !Contract.IsRequestId(r["requestId"]) || r["confirmation"]!="interrupt_current_requests") : (r["requestId"]!="" || r["confirmation"]!="" || (r["expectedSourceDigest"]!="" && !Digest(r["expectedSourceDigest"])))) throw new InvalidOperationException("INVALID_REQUEST");
            } else {
                if(r["action"]!="" || r["confirmation"]!="" || r["versionId"]!="" || r["expectedSourceDigest"]!="" || r["idlePolicy"]!="") throw new InvalidOperationException("INVALID_REQUEST");
                if(op=="update_receipt") { if(id!="" || !Contract.IsRequestId(r["requestId"])) throw new InvalidOperationException("INVALID_REQUEST"); }
                else if(op=="update_status") { if((id!="" && !Contract.Has(Ids,id)) || r["requestId"]!="") throw new InvalidOperationException("INVALID_REQUEST"); }
                else if(op=="ensure_normal_host") { if(id!="codex_bridge" || r["requestId"]!="") throw new InvalidOperationException("INVALID_REQUEST"); }
                else throw new InvalidOperationException("INVALID_REQUEST");
            }
            return r;
        }
        public static string ParameterDigest(string component,string version,string source) {
            string text=String.Join("\n",new[]{component,"update_from_source",version,source,"wait_for_idle","interrupt_current_requests"});
            using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();
        }
    }
    public sealed class UpdateTarget {
        public string componentId {get;set;}
        public bool supported {get;set;}
        public string owner {get;set;}
        public string reason {get;set;}
    }
    public sealed class UpdateReceipt {
        public string requestId {get;set;}
        public string componentId {get;set;}
        public string action {get;set;}
        public string versionId {get;set;}
        public string expectedSourceDigest {get;set;}
        public string idlePolicy {get;set;}
        public string parameterDigest {get;set;}
        public string operationId {get;set;}
        public string phase {get;set;}
        public string code {get;set;}
        public string createdAt {get;set;}
        public string updatedAt {get;set;}
        public string selectedVersion {get;set;}
        public string observedVersion {get;set;}
        public string observedBuildId {get;set;}
        public string preparedBuildId {get;set;}
        public string blockedByOperationId {get;set;}
        public bool? ready {get;set;}
    }
    // Admission/correlation metadata only. Component owners keep their own
    // canonical operation journal; this store never claims execution authority.
    public sealed class UpdateStore {
        readonly string root;
        public UpdateStore(string runtimeRoot) { root=Path.Combine(Path.GetFullPath(runtimeRoot),"workspace-update-requests"); }
        sealed class Lease : IDisposable {
            readonly Mutex mutex;
            public Lease(string key) {
                mutex=new Mutex(false,key);bool held=false;
                try { try { held=mutex.WaitOne(3000); } catch(AbandonedMutexException) { held=true; }
                    if(!held) throw new InvalidOperationException("RECEIPT_BUSY");
                } catch { mutex.Dispose();throw; }
            }
            public void Dispose(){mutex.ReleaseMutex();mutex.Dispose();}
        }
        IDisposable Lock(string id) {
            string key=PathFor(id).ToUpperInvariant();
            using(var hash=SHA256.Create()) key=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(key))).Replace("-","");
            return new Lease(@"Local\McpCc.UpdateReceipt."+key);
        }
        string PathFor(string id) {
            if(!Contract.IsRequestId(id)) throw new InvalidOperationException("INVALID_REQUEST");
            for(string p=root;!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p)) if(Directory.Exists(p) && (File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            return Path.Combine(root,id.ToLowerInvariant()+".json");
        }
        public UpdateReceipt Read(string id) {
            string path=PathFor(id);if(!File.Exists(path)) return null;
            if((File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            UpdateReceipt r;
            using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete)) {
                if(file.Length>8192) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                using(var reader=new StreamReader(file,new UTF8Encoding(false,true))) r=Contract.Json().Deserialize<UpdateReceipt>(reader.ReadToEnd());
            }
            if(r==null || r.requestId!=id.ToLowerInvariant() || !Contract.Has(UpdateContract.Ids,r.componentId) || r.action!="update_from_source" || r.idlePolicy!="wait_for_idle" ||
                !UpdateContract.Digest(r.expectedSourceDigest) || r.parameterDigest!=UpdateContract.ParameterDigest(r.componentId,r.versionId,r.expectedSourceDigest) || r.operationId!=r.requestId.Replace("-","") ||
                !Contract.Has(new[]{"QUEUED","RUNNING","ACCEPTED","REJECTED","RECOVERY_REQUIRED"},r.phase)) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            return r;
        }
        public UpdateReceipt[] Pending() {
            var rows=new List<UpdateReceipt>();if(!Directory.Exists(root)) return rows.ToArray();
            PathFor(Guid.Empty.ToString());
            // The retained request files are the query/replay index. Terminal
            // history never consumes pending capacity or prevents owner startup.
            foreach(string path in Directory.EnumerateFiles(root,"*.json")) {
                var r=Read(Path.GetFileNameWithoutExtension(path));if(r.phase=="QUEUED" || r.phase=="RUNNING") rows.Add(r);
            }
            return rows.ToArray();
        }
        public UpdateReceipt Reserve(Dictionary<string,string> request) {
            string id=request["requestId"].ToLowerInvariant(),path=PathFor(id);Directory.CreateDirectory(root);
            int active=0;
            foreach(string prior in Directory.EnumerateFiles(root,"*.json")) {
                var saved=Read(Path.GetFileNameWithoutExtension(prior));
                if(saved.phase!="ACCEPTED" && saved.phase!="REJECTED" && ++active>=256) throw new InvalidOperationException("RECEIPT_CAPACITY");
            }
            string now=DateTimeOffset.UtcNow.ToString("o");
            var r=new UpdateReceipt{requestId=id,componentId=request["componentId"],action="update_from_source",versionId=request["versionId"],expectedSourceDigest=request["expectedSourceDigest"],idlePolicy="wait_for_idle",
                parameterDigest=UpdateContract.ParameterDigest(request["componentId"],request["versionId"],request["expectedSourceDigest"]),operationId=id.Replace("-",""),phase="QUEUED",code="UPDATE_QUEUED",createdAt=now,updatedAt=now};
            Save(r,true);return r;
        }
        void Save(UpdateReceipt r,bool create) {
            string path=PathFor(r.requestId);Directory.CreateDirectory(root);
            string tmp=Path.Combine(root,".pending-"+Guid.NewGuid().ToString("N"));
            byte[] bytes=Encoding.UTF8.GetBytes(Contract.Json().Serialize(r));
            using(var stream=new FileStream(tmp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){stream.Write(bytes,0,bytes.Length);stream.Flush(true);}
            if(create) File.Move(tmp,path);
            else {
                // Retain each prior receipt as immutable admission evidence.
                string history=Path.Combine(root,"history");Directory.CreateDirectory(history);
                if((File.GetAttributes(history)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                File.Replace(tmp,path,Path.Combine(history,r.requestId+"-"+Guid.NewGuid().ToString("N")+".json"));
            }
        }
        public void Complete(string id,string phase,string code,string selected,string observed,string build,bool? ready,string prepared) {
            using(Lock(id)) {
            // PowerShell binds $null to String.Empty for this string argument.
            if(String.IsNullOrEmpty(prepared)) prepared=null;
            if(String.IsNullOrEmpty(selected)) selected=null;
            if(String.IsNullOrEmpty(observed)) observed=null;
            if(String.IsNullOrEmpty(build)) build=null;
            var r=Read(id);if(r==null || !Contract.Has(new[]{"QUEUED","RUNNING","ACCEPTED","REJECTED","RECOVERY_REQUIRED"},phase) || !Regex.IsMatch(code,"\\A[A-Z][A-Z0-9_]{0,95}\\z")) throw new InvalidOperationException("INVALID_OUTCOME");
            // Independent bootstrap and the tray can settle the same request.
            // A late worker can never regress or replace a terminal receipt.
            if(r.phase=="ACCEPTED" || r.phase=="REJECTED") return;
            if(prepared!=null && r.preparedBuildId!=null && prepared!=r.preparedBuildId) throw new InvalidOperationException("PREPARED_IDENTITY_CONFLICT");
            if(r.phase==phase && r.code==code && r.selectedVersion==selected && r.observedVersion==observed && r.observedBuildId==build && r.ready==ready && (prepared==null || r.preparedBuildId==prepared)) return;
            r.phase=phase;r.code=code;r.selectedVersion=selected;r.observedVersion=observed;r.observedBuildId=build;if(prepared!=null) r.preparedBuildId=prepared;if(phase=="ACCEPTED") r.blockedByOperationId=null;r.ready=ready;r.updatedAt=DateTimeOffset.UtcNow.ToString("o");Save(r,false);
            }
        }
        public void BlockedBy(string id,string operation) {
            if(!Regex.IsMatch(operation,"\\A[0-9a-f]{32}\\z")) throw new InvalidOperationException("INVALID_OPERATION");
            using(Lock(id)) {var r=Read(id);if(r.phase=="ACCEPTED" || r.phase=="REJECTED") return;r.blockedByOperationId=operation;Save(r,false);}
        }
    }

    // Separate fixed semantic contract; v1/v2 target lists and DTOs are unchanged.
    public static class OmiContract {
        public const string Version="cc-omi-launcher-update-v1";
        public const string Root=@"C:\project\Open Market Intelligence";
        public static bool IndependentOwner() {
            using(var p=Process.GetCurrentProcess()){bool inJob;return Native.IsProcessInJob(p.Handle,IntPtr.Zero,out inJob) && !inJob;}
        }
        public static Dictionary<string,string> Request(Dictionary<string,string> r,string challenge) {
            string[] keys={"v","nonce","challenge","operation","requestId","expectedSourceDigest"};
            if(r.Count!=keys.Length) throw new InvalidOperationException("INVALID_REQUEST");
            foreach(string k in keys) if(!r.ContainsKey(k)) throw new InvalidOperationException("INVALID_REQUEST");
            if(r["v"]!="3" || !UpdateContract.Digest(r["nonce"]) || !UpdateContract.Digest(challenge) || r["challenge"]!=challenge) throw new InvalidOperationException("INVALID_REQUEST");
            if(r["operation"]=="omi_status" && r["requestId"]=="" && r["expectedSourceDigest"]=="") return r;
            if(r["operation"]=="omi_receipt" && Contract.IsRequestId(r["requestId"]) && r["expectedSourceDigest"]=="") return r;
            if(r["operation"]=="omi_apply" && Contract.IsRequestId(r["requestId"]) && UpdateContract.Digest(r["expectedSourceDigest"])) return r;
            throw new InvalidOperationException("INVALID_REQUEST");
        }
    }
    public sealed class OmiReceipt {
        public string contract=OmiContract.Version;
        public string requestId,expectedSourceDigest,ccVersion,phase,code,createdAt,updatedAt,nativeRequestId;
        public int? updaterPid;
        public string updaterCreatedTicks;
        public string expectedLifecycle,expectedApplication,oldOwnerId,oldLauncherCreatedTicks;
        public int? oldLauncherPid;
    }
    // Admission/receipt namespace in the existing CC owner, not a second updater.
    internal sealed class OmiStore {
        readonly string root;
        public OmiStore(string runtime) {root=Path.Combine(Path.GetFullPath(runtime),"omi-launcher-update-requests");}
        string PathFor(string id) {
            if(!Contract.IsRequestId(id)) throw new InvalidOperationException("INVALID_REQUEST");
            for(string p=root;!String.IsNullOrEmpty(p);p=Path.GetDirectoryName(p)) if(Directory.Exists(p) && (File.GetAttributes(p)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            string path=Path.Combine(root,id.ToLowerInvariant()+".json");
            if(File.Exists(path) && (File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
            return path;
        }
        public OmiReceipt Read(string id) {
            string path=PathFor(id);if(!File.Exists(path)) return null;
            using(var f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete)) {
                if(f.Length>4096) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                using(var s=new StreamReader(f,new UTF8Encoding(false,true))) {
                    var r=Contract.Json().Deserialize<OmiReceipt>(s.ReadToEnd());
                    if(r==null || r.contract!=OmiContract.Version || r.requestId!=id.ToLowerInvariant() || !UpdateContract.Digest(r.expectedSourceDigest) ||
                        !Contract.Has(new[]{"QUEUED","RUNNING","ACCEPTED","REJECTED","RECOVERY_REQUIRED"},r.phase) ||
                        (!String.IsNullOrEmpty(r.nativeRequestId) && !Contract.IsRequestId(r.nativeRequestId))) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                    return r;
                }
            }
        }
        IEnumerable<OmiReceipt> All() {
            PathFor(Guid.Empty.ToString());if(!Directory.Exists(root)) yield break;
            int count=0;foreach(string p in Directory.EnumerateFiles(root,"*.json")) {
                if(++count>2048) throw new InvalidOperationException("RECEIPT_CAPACITY");yield return Read(Path.GetFileNameWithoutExtension(p));
            }
        }
        public bool Blocks() {
            foreach(var r in All()) if(r.phase=="QUEUED" || r.phase=="RUNNING" || r.phase=="RECOVERY_REQUIRED") return true;
            return false;
        }
        void Save(OmiReceipt r,bool create) {
            string path=PathFor(r.requestId);Directory.CreateDirectory(root);
            string temp=Path.Combine(root,".pending-"+Guid.NewGuid().ToString("N"));
            byte[] bytes=Encoding.UTF8.GetBytes(Contract.Json().Serialize(r));
            using(var f=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.Write(bytes,0,bytes.Length);f.Flush(true);}
            if(create) File.Move(temp,path);
            else {
                string history=Path.Combine(root,"history");Directory.CreateDirectory(history);
                if((File.GetAttributes(history)&FileAttributes.ReparsePoint)!=0) throw new InvalidOperationException("RECEIPT_UNAVAILABLE");
                File.Replace(temp,path,Path.Combine(history,r.requestId+"-"+Guid.NewGuid().ToString("N")+".json"));
            }
        }
        public OmiReceipt Reserve(Dictionary<string,string> request,string version) {
            string now=DateTimeOffset.UtcNow.ToString("o");
            var r=new OmiReceipt{requestId=request["requestId"].ToLowerInvariant(),expectedSourceDigest=request["expectedSourceDigest"],ccVersion=version,phase="QUEUED",code="OMI_APPLY_QUEUED",createdAt=now,updatedAt=now};Save(r,true);return r;
        }
        public void Progress(string id,int pid,long ticks) {
            var r=Read(id);if(r.phase!="QUEUED" || pid<=0 || ticks<=0) throw new InvalidOperationException("INVALID_OUTCOME");
            r.phase="RUNNING";r.code="OMI_UPDATER_DISPATCHED";r.updaterPid=pid;r.updaterCreatedTicks=ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);r.updatedAt=DateTimeOffset.UtcNow.ToString("o");Save(r,false);
        }
        public void Preflight(string id,string lifecycle,string application,string owner,int pid,long ticks) {
            var r=Read(id);if(r.phase!="QUEUED" || !UpdateContract.Digest(lifecycle) || !UpdateContract.Digest(application) || !Contract.IsRequestId(owner) || pid<=0 || ticks<=0) throw new InvalidOperationException("INVALID_PREFLIGHT");
            r.expectedLifecycle=lifecycle;r.expectedApplication=application;r.oldOwnerId=owner;r.oldLauncherPid=pid;r.oldLauncherCreatedTicks=ticks.ToString();Save(r,false);
        }
        public void Complete(string id,string phase,string code,string nativeId) {
            var r=Read(id);if(r==null || !Contract.Has(new[]{"ACCEPTED","REJECTED","RECOVERY_REQUIRED"},phase) || !Regex.IsMatch(code,"\\A[A-Z][A-Z0-9_]{0,95}\\z") ||
                (!String.IsNullOrEmpty(nativeId) && !Contract.IsRequestId(nativeId))) throw new InvalidOperationException("INVALID_OUTCOME");
            if(r.phase=="ACCEPTED" || r.phase=="REJECTED") return;
            if(!String.IsNullOrEmpty(r.nativeRequestId) && !String.IsNullOrEmpty(nativeId) && r.nativeRequestId!=nativeId) throw new InvalidOperationException("OPERATION_CONFLICT");
            r.phase=phase;r.code=code;if(!String.IsNullOrEmpty(nativeId)) r.nativeRequestId=nativeId.ToLowerInvariant();r.updatedAt=DateTimeOffset.UtcNow.ToString("o");Save(r,false);
        }
        public void RecoverInterrupted() {foreach(var r in All()) if(r.phase=="RUNNING" || r.phase=="QUEUED") Complete(r.requestId,"RECOVERY_REQUIRED","OMI_OWNER_RESTARTED_NO_REDISPATCH",null);}
    }
    // Retained process and bounded stream capture. No Job/breakaway, shell or kill.
    public sealed class OmiChild : IDisposable {
        readonly Process process;
        readonly Task<string> output,error;
        readonly object capture=new object();
        string outputTail="",errorTail="";
        Stopwatch exitDrain;
        public bool StreamDrainBoundReached {get;private set;}
        public static OmiChild Start() {
            if(!OmiContract.IndependentOwner()) throw new InvalidOperationException("OMI_CC_OWNER_JOB_UNVERIFIED");
            var i=new ProcessStartInfo{FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments="-NoProfile -NonInteractive -File \""+OmiContract.Root+@"\scripts\apply-omi-update.ps1"+"\"",WorkingDirectory=OmiContract.Root};
            return new OmiChild(i);
        }
        internal OmiChild(ProcessStartInfo info) {
            info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
            process=new Process{StartInfo=info};if(!process.Start()) throw new InvalidOperationException("OMI_UPDATER_START_FAILED");
            IntPtr retained=process.Handle;output=Drain(process.StandardOutput,false);error=Drain(process.StandardError,true);
        }
        async Task<string> Drain(StreamReader reader,bool stderr) {
            char[] buffer=new char[2048];string tail="";int n;
            try {while((n=await reader.ReadAsync(buffer,0,buffer.Length).ConfigureAwait(false))>0){tail+=new string(buffer,0,n);if(tail.Length>32768) tail=tail.Substring(tail.Length-32768);lock(capture){if(stderr) errorTail=tail;else outputTail=tail;}}}
            catch(IOException){}catch(ObjectDisposedException){}
            return tail;
        }
        public int Pid {get{return process.Id;}}
        public long CreatedTicks {get{return process.StartTime.ToUniversalTime().Ticks;}}
        // A legitimate successor can inherit stdout. Its lifetime must not hold
        // this finite updater open. Never WaitForExit()'s unbounded stream drain.
        public bool Finished {get{if(!process.HasExited) return false;if(exitDrain==null) exitDrain=Stopwatch.StartNew();if(output.IsCompleted && error.IsCompleted) return true;if(exitDrain.ElapsedMilliseconds<1500) return false;StreamDrainBoundReached=true;return true;}}
        public int ExitCode {get{return process.ExitCode;}}
        public bool StreamsSettled {get{return output.IsCompleted && error.IsCompleted;}}
        public string Output {get{lock(capture) return outputTail;}}
        public string ErrorCode {get{string s;lock(capture) s=errorTail.Trim();return Regex.IsMatch(s,"\\AUPDATE_[A-Z_]{1,80}\\z") ? s : "OMI_UPDATER_RESULT_UNVERIFIED";}}
        public void Dispose(){process.Dispose();}
    }
    public static class OmiClient {
        public static string Call(string operation,string id,string digest,int ownerPid,long ownerTicks) {
            return CallPipe(Contract.PipeName,operation,id,digest,ownerPid,ownerTicks);
        }
        internal static string CallPipe(string name,string operation,string id,string digest,int ownerPid,long ownerTicks) {
            using(var owner=Process.GetProcessById(ownerPid)) using(var pipe=new NamedPipeClientStream(".",name,PipeDirection.InOut,PipeOptions.Asynchronous)) {
                IntPtr retained=owner.Handle;if(owner.HasExited || owner.StartTime.ToUniversalTime().Ticks!=ownerTicks) throw new InvalidOperationException("CC_OWNER_CHANGED");
                pipe.Connect(Contract.DeadlineMs);uint peer;
                if(!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle,out peer) || peer!=(uint)ownerPid) throw new InvalidOperationException("CC_PIPE_OWNER_MISMATCH");
                var clock=Stopwatch.StartNew();string challenge=Frame.Read(pipe,clock),nonce=Contract.Nonce();
                var r=new Dictionary<string,string>{{"v","3"},{"nonce",nonce},{"challenge",challenge},{"operation",operation},{"requestId",id},{"expectedSourceDigest",digest}};
                string body=Contract.Json().Serialize(r);Contract.Request(body,challenge);Frame.Write(pipe,body,clock);
                string reply=Frame.Read(pipe,clock);var result=Contract.Json().Deserialize<Dictionary<string,object>>(reply);
                if(!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle,out peer) || peer!=(uint)ownerPid || owner.HasExited ||
                    !result.ContainsKey("v") || (string)result["v"]!="3" || (string)result["nonce"]!=nonce || (string)result["operation"]!=operation || (string)result["requestId"]!=id ||
                    (string)result["contract"]!=OmiContract.Version) throw new InvalidOperationException("OMI_REPLY_UNVERIFIED");
                return reply;
            }
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
        readonly UpdateStore updates;
        readonly OmiStore omi;
        OmiReceipt pendingOmi;
        string activeOmi, omiSource, omiVersion;
        long omiObserved;
        readonly Queue<string> updateQueue=new Queue<string>();
        readonly Dictionary<string,long> updateRetryAt=new Dictionary<string,long>();
        readonly Dictionary<string,string> sourceDigests=new Dictionary<string,string>();
        string activeUpdate;
        bool normalRecovery;
        RestartRequest pending;
        string activeRequest;
        long acceptedTicks;
        public static Owner Open(string runtimeRoot) { return new Owner(Contract.PipeName, runtimeRoot); }
        internal Owner(string name, string runtimeRoot) {
            receipts=new ReceiptStore(runtimeRoot);
            updates=new UpdateStore(runtimeRoot);
            omi=new OmiStore(runtimeRoot);
            omi.RecoverInterrupted(); // Observation only; never re-enqueue an uncertain Apply.
            foreach(var r in updates.Pending()) {
                if(r.phase=="QUEUED") updateQueue.Enqueue(r.requestId);
                else updates.Complete(r.requestId,"RECOVERY_REQUIRED","OWNER_RESTARTED",r.selectedVersion,r.observedVersion,r.observedBuildId,null,r.preparedBuildId);
            }
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
                // A busy status worker is not permission to discard accepted work.
                // The durable v1 UNKNOWN remains recoverable after owner restart.
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
        public bool HasActiveRequest { get { lock(sync) return activeRequest!=null || activeUpdate!=null || activeOmi!=null; } }
        public void PublishOmiSource(string digest,string version) {
            lock(sync) { if(digest!=null && !UpdateContract.Digest(digest)) throw new InvalidOperationException("INVALID_SOURCE_DIGEST");
                omiSource=digest;omiVersion=version;omiObserved=Stopwatch.GetTimestamp(); }
        }
        public OmiReceipt TakePendingOmi() { lock(sync) {var r=pendingOmi;pendingOmi=null;return r;} }
        public void ProgressOmi(string id,int pid,long ticks) { lock(sync) {omi.Progress(id,pid,ticks);} }
        public void PreflightOmi(string id,string lifecycle,string app,string owner,int pid,long ticks) {lock(sync) {omi.Preflight(id,lifecycle,app,owner,pid,ticks);} }
        public void CompleteOmi(string id,string phase,string code,string nativeId) {
            lock(sync) {try{omi.Complete(id,phase,code,nativeId);}finally{if(activeOmi==id) activeOmi=null;} }
        }
        public void ObserveOmi(string id,string code) {lock(sync) {omi.Complete(id,"RECOVERY_REQUIRED",code,null);} }
        internal string DispatchOmi(Dictionary<string,string> r) {
            lock(sync) {
                string code="OMI_CAPABILITY_OBSERVED";OmiReceipt receipt=null;
                bool fresh=omiSource!=null && Stopwatch.GetTimestamp()-omiObserved<90*Stopwatch.Frequency;
                if(r["operation"]=="omi_receipt") {receipt=omi.Read(r["requestId"]);code=receipt==null ? "RECEIPT_NOT_FOUND" : "RECEIPT_OBSERVED";}
                else if(r["operation"]=="omi_apply") {
                    receipt=omi.Read(r["requestId"]);
                    if(receipt!=null) {code=receipt.expectedSourceDigest==r["expectedSourceDigest"] ? "REQUEST_REPLAY" : "REQUEST_CONFLICT";if(code=="REQUEST_CONFLICT") receipt=null;}
                    else if(closing) code="OWNER_CLOSING";
                    else if(!fresh || String.IsNullOrEmpty(omiVersion)) code="OMI_CAPABILITY_UNAVAILABLE";
                    else if(omiSource!=r["expectedSourceDigest"]) code="OMI_SOURCE_CHANGED";
                    else if(activeRequest!=null || activeUpdate!=null || activeOmi!=null || updateQueue.Count!=0) code="ACTION_BUSY";
                    else if(omi.Blocks()) code="OMI_PRIOR_REQUEST_REQUIRES_INSPECTION";
                    else {receipt=omi.Reserve(r,omiVersion);pendingOmi=receipt;activeOmi=receipt.requestId;code="OMI_APPLY_QUEUED";}
                }
                return Contract.Json().Serialize(new {v="3",contract=OmiContract.Version,nonce=r["nonce"],operation=r["operation"],requestId=r["requestId"],code=code,
                    supported=true,available=fresh && !closing && !HasActiveRequest && updateQueue.Count==0 && !omi.Blocks(),sourceDigest=fresh ? omiSource : null,ccVersion=omiVersion,
                    ccPid=Process.GetCurrentProcess().Id,receipt=receipt});
            }
        }
        string SafeOmiDispatch(Dictionary<string,string> r) {
            try{return DispatchOmi(r);}catch{return Contract.Json().Serialize(new {v="3",contract=OmiContract.Version,nonce=r["nonce"],operation=r["operation"],requestId=r["requestId"],code="RECEIPT_UNAVAILABLE",supported=true,available=false,receipt=(OmiReceipt)null});}
        }
        public void PublishSourceDigest(string id,string digest) { lock(sync) {if(!UpdateContract.Supported(id) || (digest!=null && !UpdateContract.Digest(digest))) throw new InvalidOperationException("INVALID_SOURCE_DIGEST");sourceDigests[id]=digest;} }
        public bool TakeNormalRecovery() { lock(sync) {bool value=normalRecovery;normalRecovery=false;return value;} }
        public UpdateReceipt TakePendingUpdate() {
            lock(sync) {
                if(closing || activeRequest!=null || activeUpdate!=null || activeOmi!=null || updateQueue.Count==0) return null;
                UpdateReceipt r=null;string id=null;
                int remaining=updateQueue.Count;
                while(remaining-->0){
                    id=updateQueue.Dequeue();r=updates.Read(id);
                    long retry;
                    if(updateRetryAt.TryGetValue(id,out retry) && Stopwatch.GetTimestamp()<retry){updateQueue.Enqueue(id);r=null;continue;}
                    updateRetryAt.Remove(id);
                    if(r!=null && (r.phase=="QUEUED" || r.phase=="RECOVERY_REQUIRED" || (r.phase=="RUNNING" && r.componentId=="mcp_control_center" && r.preparedBuildId!=null))) break;
                    r=null;
                }
                if(r==null) return null;
                activeUpdate=id;
                // QUEUED is durable and never expires. Idle polls retain their
                // unchanged receipt; the canonical DailyCode reservation precedes
                // lifecycle dispatch. Recovery retains its uncertain boundary.
                if(r.phase=="QUEUED" && r.code!="WAITING_FOR_IDLE") updates.Complete(id,"RUNNING","DISPATCHING",null,null,null,null,null);
                return r;
            }
        }
        public void CompleteUpdate(string id,string phase,string code,string selected,string observed,string build,bool? ready,string prepared) {
            lock(sync) {try{updates.Complete(id,phase,code,selected,observed,build,ready,prepared);}finally{activeUpdate=null;} if(phase=="QUEUED" && !updateQueue.Contains(id)){updateRetryAt[id]=Stopwatch.GetTimestamp()+5*Stopwatch.Frequency;updateQueue.Enqueue(id);}}
        }
        public void ReleaseUpdate(string id) { lock(sync) {if(activeUpdate!=id) throw new InvalidOperationException("ACTIVE_REQUEST_REQUIRED");activeUpdate=null;} }
        public UpdateReceipt ReadUpdate(string id) {lock(sync) return updates.Read(id);}
        public void SetUpdateBlocker(string id,string operation) {lock(sync) updates.BlockedBy(id,operation);}
        public bool TryBeginShutdown() {
            lock(sync) {
                closing=true;return activeRequest==null && activeUpdate==null && activeOmi==null;
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
                    else if(activeRequest!=null || activeUpdate!=null || activeOmi!=null) { code="ACTION_BUSY"; }
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
        internal string DispatchUpdate(Dictionary<string,string> r) {
            lock(sync) {
                string op=r["operation"],id=r["componentId"],code="OWNER_OBSERVATION",digest=null;
                UpdateReceipt receipt=null;var targets=new List<UpdateTarget>();
                if(op=="ensure_normal_host") {if(!closing) normalRecovery=true;code=closing ? "OWNER_CLOSING" : "NORMAL_HOST_RECOVERY_QUEUED";}
                else if(op=="update_status" || op=="update_preview") {
                    foreach(string target in UpdateContract.Ids) if(id=="" || id==target) {
                        string pin;bool available=sourceDigests.TryGetValue(target,out pin) && pin!=null;
                        targets.Add(new UpdateTarget{componentId=target,supported=available,owner=available ? (target=="codex_bridge" ? "daily_code" : target=="mcp_control_center" ? "independent_bootstrap" : "component_controller") : null,reason=available ? null : "SOURCE_NOT_OBSERVED"});
                    }
                    if(op=="update_preview") { sourceDigests.TryGetValue(id,out digest);code=digest==null ? "SOURCE_NOT_OBSERVED" : "SOURCE_OBSERVED"; }
                } else {
                    receipt=updates.Read(r["requestId"]);
                    if(op=="update_receipt") code=receipt==null ? "RECEIPT_NOT_FOUND" : "RECEIPT_OBSERVED";
                    else if(receipt!=null) {
                        code=receipt.parameterDigest==UpdateContract.ParameterDigest(id,r["versionId"],r["expectedSourceDigest"]) ? "REQUEST_REPLAY" : "REQUEST_CONFLICT";
                        if(code=="REQUEST_CONFLICT") receipt=null;
                        else if((receipt.phase=="RECOVERY_REQUIRED" || (receipt.phase=="RUNNING" && id=="mcp_control_center" && receipt.preparedBuildId!=null)) && !closing && activeUpdate!=receipt.requestId && !updateQueue.Contains(receipt.requestId)) updateQueue.Enqueue(receipt.requestId);
                    } else if(closing) code="OWNER_CLOSING";
                    else {
                        // Reserve correlation before dispatch, including requests
                        // that later fail source/owner admission. No lost timeout.
                        receipt=updates.Reserve(r);updateQueue.Enqueue(receipt.requestId);code="UPDATE_QUEUED";
                    }
                }
                return Contract.Json().Serialize(new{v="2",nonce=r["nonce"],operation=op,componentId=id,action=r["action"],requestId=r["requestId"],code=code,targets=targets.ToArray(),sourceDigest=digest,receipt=receipt,mutationEnabled=op=="update" || op=="update_receipt" || op=="ensure_normal_host"});
            }
        }
        string SafeUpdateDispatch(Dictionary<string,string> request) {
            try{return DispatchUpdate(request);}catch(Exception e){
                string code=e.Message=="RECEIPT_CAPACITY" ? "RECEIPT_CAPACITY" : "RECEIPT_UNAVAILABLE";
                return Contract.Json().Serialize(new{v="2",nonce=request["nonce"],operation=request["operation"],componentId=request["componentId"],action=request["action"],requestId=request["requestId"],code=code,targets=new UpdateTarget[0],sourceDigest=(string)null,receipt=(UpdateReceipt)null,mutationEnabled=true});
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
                        string reply=request["v"]=="3" ? SafeOmiDispatch(request) : request["v"]=="2" ? SafeUpdateDispatch(request) : (request["operation"]=="restart" || request["operation"]=="receipt") ? SafeDispatch(request) : sample==null && request["operation"]=="diagnostics" ? Snapshot.DiagnosticsReply(request,null,"SNAPSHOT_UNAVAILABLE",null) : sample==null ? Contract.Json().Serialize(new {
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
