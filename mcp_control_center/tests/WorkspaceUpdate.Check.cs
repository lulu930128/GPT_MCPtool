namespace McpCc.WorkspaceLocal {
    public static class UpdateFixture {
        static int count;
        static void Check(bool value,string label){if(!value)throw new System.Exception(label);count++;}
        static System.Collections.Generic.Dictionary<string,string> Request(string op,string id,string request,string version,string digest){
            bool mutate=op=="update",preview=op=="update_preview";
            var r=new System.Collections.Generic.Dictionary<string,string>{{"v","2"},{"nonce",new string('a',64)},{"challenge",new string('b',64)},{"operation",op},{"componentId",id},{"requestId",request},
                {"action",mutate||preview?"update_from_source":""},{"confirmation",mutate?"interrupt_current_requests":""},{"versionId",version},{"expectedSourceDigest",digest},{"idlePolicy",mutate||preview?"wait_for_idle":""}};
            return Contract.Request(Contract.Json().Serialize(r),new string('b',64));
        }
        public static int Run(string root){
            string key=System.Guid.NewGuid().ToString(),name="mcpcc-local-fixture-"+System.Guid.NewGuid().ToString("N");
            var r=Request("update","project_reading",key,"fixture-v1",new string('c',64));
            using(var owner=new Owner(name,root)){
                Check(owner.DispatchUpdate(r).Contains("UPDATE_QUEUED"),"durable acceptance");
                var store=new UpdateStore(root);var receipt=store.Read(key);
                Check(receipt.phase=="QUEUED" && receipt.operationId==key.Replace("-","") && receipt.parameterDigest==UpdateContract.ParameterDigest("project_reading","fixture-v1",new string('c',64)),"correlation before dispatch");
                Check(owner.DispatchUpdate(r).Contains("REQUEST_REPLAY"),"same id no duplicate");
                var conflict=Request("update","project_reading",key,"fixture-v2",new string('c',64));
                Check(owner.DispatchUpdate(conflict).Contains("REQUEST_CONFLICT"),"same id conflict");
                Check(owner.TakePendingUpdate().requestId==key && store.Read(key).phase=="RUNNING","running durable before work");
                Check(owner.TakePendingUpdate()==null,"one active worker");
                owner.CompleteUpdate(key,"RECOVERY_REQUIRED","TEST_INTERRUPTION",null,null,null,null,new string('d',64));
                Check(owner.DispatchUpdate(r).Contains("REQUEST_REPLAY"),"same request recovery queued");
                // Independent bootstrap finishes after replay enqueue, before take.
                store.Complete(key,"ACCEPTED","UPDATE_ACCEPTED","fixture-v1","1.7.0",new string('d',64),true,new string('d',64));
                Check(owner.TakePendingUpdate()==null,"terminal queued race skipped");
                Check(store.Read(key).phase=="ACCEPTED","terminal not overwritten");
                var secondStore=new UpdateStore(root);
                secondStore.Complete(key,"RUNNING","CC_BOOTSTRAP_PENDING",null,null,null,null,null);
                secondStore.Complete(key,"RECOVERY_REQUIRED","TEST_LATE_FAILURE",null,null,null,null,null);
                Check(store.Read(key).phase=="ACCEPTED" && store.Read(key).preparedBuildId==new string('d',64),"late other store cannot regress terminal");
                string cc=System.Guid.NewGuid().ToString();
                var ccRequest=Request("update","mcp_control_center",cc,"cc-fixture",new string('a',64));
                owner.DispatchUpdate(ccRequest);owner.TakePendingUpdate();
                owner.CompleteUpdate(cc,"RUNNING","CC_BOOTSTRAP_PENDING",null,null,null,null,new string('b',64));
                // The original bootstrap may have died while this same owner stayed alive.
                owner.DispatchUpdate(ccRequest);
                Check(owner.TakePendingUpdate().phase=="RUNNING","pinned cc running replay reaches recovery without owner restart");
                owner.CompleteUpdate(cc,"RECOVERY_REQUIRED","TEST_PROCESS_START_FAILURE",null,null,null,null,null);
                Check(store.Read(cc).preparedBuildId==new string('b',64),"launch failure preserves durable prepared pin");
                owner.DispatchUpdate(ccRequest);owner.TakePendingUpdate();
                secondStore.Complete(cc,"ACCEPTED","CC_OWNER_AND_IPC_VERIFIED","cc-fixture","cc-fixture",new string('b',64),true,new string('b',64));
                owner.CompleteUpdate(cc,"RUNNING","CC_BOOTSTRAP_PENDING",null,null,null,null,new string('b',64));
                Check(store.Read(cc).phase=="ACCEPTED","taken stale recovery cannot regress bootstrap completion");
                string pending=System.Guid.NewGuid().ToString();
                owner.DispatchUpdate(Request("update","codex_bridge",pending,"fixture-v2",new string('e',64)));
                System.IO.File.WriteAllText(System.IO.Path.Combine(root,"pending-id.txt"),pending);
            }
            using(var owner=new Owner(name,root)){
                string pending=System.IO.File.ReadAllText(System.IO.Path.Combine(root,"pending-id.txt"));
                Check(owner.TakePendingUpdate().requestId==pending,"queued survives owner restart");
                owner.CompleteUpdate(pending,"RUNNING","CC_BOOTSTRAP_PENDING",null,null,null,null,new string('f',64));
            }
            using(var owner=new Owner(name,root)){
                string pending=System.IO.File.ReadAllText(System.IO.Path.Combine(root,"pending-id.txt"));var store=new UpdateStore(root);
                Check(store.Read(pending).phase=="RECOVERY_REQUIRED" && store.Read(pending).preparedBuildId==new string('f',64),"restart preserves candidate pin and uncertainty");
                owner.DispatchUpdate(Request("update","codex_bridge",pending,"fixture-v2",new string('e',64)));
                Check(owner.TakePendingUpdate().phase=="RECOVERY_REQUIRED","recovery never fresh dispatch");
                owner.SetUpdateBlocker(pending,new string('1',32));
                owner.CompleteUpdate(pending,"RECOVERY_REQUIRED","UPDATE_BLOCKED_BY_OTHER_OPERATION",null,null,null,null,null);
                Check(store.Read(pending).blockedByOperationId==new string('1',32) && store.Read(pending).preparedBuildId==new string('f',64),"other operation and candidate pin preserved");
            }
            bool denied=false;try{Request("update","project_reading",System.Guid.NewGuid().ToString(),"BAD.VERSION",new string('c',64));}catch{denied=true;}Check(denied,"version bound");
            return count;
        }
        public static Owner Open(string root){return new Owner("mcpcc-local-fixture-"+System.Guid.NewGuid().ToString("N"),root);}
        public static UpdateReceipt Queue(Owner owner,string id){
            owner.DispatchUpdate(Request("update","mcp_control_center",id,"cc-fixture",new string('a',64)));
            return owner.TakePendingUpdate();
        }
        public static UpdateReceipt Replay(Owner owner,string id){
            owner.DispatchUpdate(Request("update","mcp_control_center",id,"cc-fixture",new string('a',64)));
            return owner.TakePendingUpdate();
        }
    }
}
