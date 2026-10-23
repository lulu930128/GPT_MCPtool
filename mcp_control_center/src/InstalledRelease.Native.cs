using System;
using System.IO;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;

// Bulk .NET reader avoids thousands of PowerShell provider invocations. No cache,
// process launch, ACL mutation, caller command, or activation switch.
public static class McpCcInstalledTree {
    static bool Trusted(string sid) {
        return sid == "S-1-5-18" || sid == "S-1-5-32-544" ||
            sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    }
    public static void AssertAcl(FileSystemSecurity acl) {
        if (!Trusted(acl.GetOwner(typeof(SecurityIdentifier)).Value)) throw new InvalidOperationException("PROTECTED_OWNER_REQUIRED");
        var raw = new RawSecurityDescriptor(acl.GetSecurityDescriptorBinaryForm(), 0);
        if (raw.DiscretionaryAcl == null) throw new InvalidOperationException("PROTECTED_DACL_REQUIRED");
        const FileSystemRights write = FileSystemRights.Write | FileSystemRights.Delete |
            FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule ace in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
            if (ace.AccessControlType == AccessControlType.Allow && !Trusted(ace.IdentityReference.Value) && (ace.FileSystemRights & write) != 0)
                throw new InvalidOperationException("PROTECTED_WRITE_REJECTED");
        }
    }
    public static string VerifyTree(string root) {
        root = Path.GetFullPath(root).TrimEnd('\\');
        var queue = new Stack<string>(); queue.Push(root);
        var rows = new List<string>(); int count = 0;
        using (var hash = SHA256.Create()) {
            while (queue.Count != 0) {
                var directory = new DirectoryInfo(queue.Pop());
                if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("INSTALLED_REPARSE_REJECTED");
                AssertAcl(directory.GetAccessControl());
                foreach (var child in directory.GetFileSystemInfos()) {
                    if (++count > 100000) throw new InvalidOperationException("INSTALLED_TREE_LIMIT");
                    if ((child.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("INSTALLED_REPARSE_REJECTED");
                    string relative = child.FullName.Substring(root.Length + 1).Replace('\\','/');
                    var dir = child as DirectoryInfo;
                    if (dir != null) {
                        AssertAcl(dir.GetAccessControl());
                        rows.Add("D " + relative); queue.Push(dir.FullName);
                    } else {
                        var file = (FileInfo)child;
                        AssertAcl(file.GetAccessControl());
                        if (Path.GetFileName(root) == "mcp_control_center" && relative == "config/installed-release.json") continue;
                        using (var input = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                            rows.Add("F " + relative + " " + BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant());
                        }
                    }
                }
            }
            rows.Sort(StringComparer.Ordinal);
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", rows) + "\n"))).Replace("-", "").ToLowerInvariant();
        }
    }
}
