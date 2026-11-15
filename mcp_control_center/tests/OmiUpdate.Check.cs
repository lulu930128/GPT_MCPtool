namespace McpCc.WorkspaceLocal {
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    public static class OmiFixture {
        static int checks;
        static void Check(bool v,string why){if(!v) throw new Exception("FAIL: "+why);checks++;}
        static Dictionary<string,string> Request(string op,string id,string digest) {
            return Contract.Request(Contract.Json().Serialize(new Dictionary<string,string>{{"v","3"},{"nonce",new string('a',64)},{"challenge",new string('b',64)},
                {"operation",op},{"requestId",id},{"expectedSourceDigest",digest}}),new string('b',64));
        }
        public static Owner Open(string name,string root) {
            if(!name.StartsWith("mcpcc-omi-fixture-",StringComparison.Ordinal)) throw new Exception("FIXTURE_NAMESPACE_REQUIRED");
            var o=new Owner(name,root);o.PublishOmiSource(new string('a',64),"fixture-v1");o.Start();return o;
        }
        public static string Call(string pipe,string op,string id,string digest,int pid,long ticks) {
            if(!pipe.StartsWith("mcpcc-omi-fixture-",StringComparison.Ordinal)) throw new Exception("FIXTURE_NAMESPACE_REQUIRED");
            return OmiClient.CallPipe(pipe,op,id,digest,pid,ticks);
        }
        public static string Submit(Owner owner,string id,string digest){return owner.DispatchOmi(Request("omi_apply",id,digest));}
        public static string Receipt(Owner owner,string id){return owner.DispatchOmi(Request("omi_receipt",id,""));}
        public static OmiChild Child(string script,string root) {
            if(!Path.GetFileName(root).StartsWith("mcpcc-omi-fixture-",StringComparison.Ordinal)) throw new Exception("FIXTURE_ROOT_REQUIRED");
            return new OmiChild(new ProcessStartInfo{FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments="-NoProfile -NonInteractive -File \""+script+"\" -Mode Updater -FixtureRoot \""+root+"\"",WorkingDirectory=root});
        }
        public static int Run(string root) {
            string name="mcpcc-omi-fixture-"+Guid.NewGuid().ToString("N"),id=Guid.NewGuid().ToString(),digest=new string('a',64);
            Check(UpdateContract.Ids.Length==9 && !UpdateContract.Supported("omi_launcher"),"v2 target list unchanged");
            Check(Contract.Ids.Length==7,"v1 targets unchanged");
            bool bad=false;try{Request("omi_apply",id,"bad");}catch{bad=true;}Check(bad,"digest validation");
            bad=false;try{Request("restart",id,digest);}catch{bad=true;}Check(bad,"fixed semantic operations");
            var r=Request("omi_apply",id,digest);r["command"]="whoami";bad=false;try{OmiContract.Request(r,new string('b',64));}catch{bad=true;}Check(bad,"no arbitrary commands");
            using(var o=new Owner(name,root)) {
                Check(Submit(o,id,digest).Contains("OMI_CAPABILITY_UNAVAILABLE"),"deployment capability required");
                o.PublishOmiSource(digest,"fixture-v1");
                Check(Submit(o,id,new string('c',64)).Contains("OMI_SOURCE_CHANGED"),"source pin before reservation");
                Check(Submit(o,id,digest).Contains("OMI_APPLY_QUEUED"),"durable reservation");
                Check(o.HasActiveRequest && !o.TryBeginShutdown(),"owner drains pending worker before exit");
                Check(Submit(o,id,digest).Contains("REQUEST_REPLAY"),"same UUID replay");
                Check(Submit(o,id,new string('c',64)).Contains("REQUEST_CONFLICT"),"parameter conflict");
                Check(o.TakePendingUpdate()==null,"serialized against component source updates");
                var work=o.TakePendingOmi();Check(work.requestId==id && o.TakePendingOmi()==null,"one dispatch only");
                o.CompleteOmi(id,"ACCEPTED","OMI_LAUNCHER_BACKEND_VERIFIED",Guid.NewGuid().ToString());
                o.CompleteOmi(id,"RECOVERY_REQUIRED","LATE_WORKER",null);
                Check(Receipt(o,id).Contains("ACCEPTED"),"terminal is monotonic");
                Check(Submit(o,id,digest).Contains("REQUEST_REPLAY") && o.TakePendingOmi()==null,"terminal replay never dispatches");
            }
            using(var o=new Owner(name,root)) {
                o.PublishOmiSource(digest,"fixture-v2");string next=Guid.NewGuid().ToString();
                Check(Submit(o,next,digest).Contains("OMI_APPLY_QUEUED"),"new UUID can explicitly update the same source");
                Check(o.TakePendingOmi()!=null,"new explicit operation dispatched once");
            }
            using(var o=new Owner(name,root)) {
                o.PublishOmiSource(digest,"fixture-v2");
                Check(o.TakePendingOmi()==null,"restart never re-enqueues uncertain apply");
                Check(Submit(o,Guid.NewGuid().ToString(),digest).Contains("OMI_PRIOR_REQUEST_REQUIRES_INSPECTION"),"uncertainty blocks replacement UUID");
                Check(o.DispatchOmi(Request("omi_status","","")).Contains("\"available\":false"),"uncertainty visible in availability");
            }
            return checks;
        }
    }
}
