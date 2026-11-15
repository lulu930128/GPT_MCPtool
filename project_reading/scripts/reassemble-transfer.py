"""Offline only: verify downloaded manifest pages and parts, then reconstruct bytes.

python scripts/reassemble-transfer.py --parts downloads --output restored.zip --manifest-dir manifests
No extraction, network, or overwrite. Manifest pages must be structuredContent objects
from list_segmented_transfer(collection="parts"), saved as UTF-8 JSON.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path


def manifest_pages(directory: Path) -> list[Path]:
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Manifest directory must be an ordinary directory")
    pages = []
    for file in directory.iterdir():
        if file.suffix.lower() != ".json":
            continue
        if file.is_symlink() or not file.is_file() or file.stat().st_nlink != 1:
            raise ValueError("Manifest pages must be ordinary non-linked files")
        if file.stat().st_size > 1024 * 1024:
            raise ValueError("Manifest page exceeds 1 MiB")
        pages.append(file)
        if len(pages) > 100_000:
            raise ValueError("Too many manifest pages")
    if not pages:
        raise ValueError("No manifest JSON pages found")
    return sorted(pages)


def reconstruct(pages: list[Path], parts: Path, output: Path) -> dict:
    reference = None
    records = {}
    for page_path in pages:
        if page_path.is_symlink() or not page_path.is_file() or page_path.stat().st_nlink != 1 or page_path.stat().st_size > 1024 * 1024:
            raise ValueError("Manifest page must be an ordinary file of at most 1 MiB")
        page = json.loads(page_path.read_text(encoding="utf-8-sig"))
        if page.get("collection") != "parts" or page.get("state") != "ready":
            raise ValueError("Expected a ready parts manifest page")
        key = tuple(page.get(k) for k in ("taskId", "archiveBytes", "archiveSha256", "chunkCount", "complete"))
        if (type(key[1]) is not int or not 0 <= key[1] <= 100_000_000_000 or
                type(key[3]) is not int or not 1 <= key[3] <= 100_000 or
                not isinstance(key[2], str) or not re.fullmatch(r"[a-f0-9]{64}", key[2])):
            raise ValueError("Invalid manifest size, count or SHA-256")
        if reference is None:
            reference = key
        elif key != reference:
            raise ValueError("Mixed manifests")
        for record in page["records"]:
            index = record["index"]
            if type(index) is not int or index < 0 or index in records:
                raise ValueError("Invalid or duplicate part index")
            if (index >= key[3] or type(record["length"]) is not int or not 0 <= record["length"] <= 12 * 1024 * 1024 or
                    type(record["offset"]) is not int or not 0 <= record["offset"] <= key[1] or
                    not re.fullmatch(r"[a-f0-9]{64}", record["sha256"])):
                raise ValueError("Invalid part metadata")
            records[index] = record
    if reference is None or set(records) != set(range(reference[3])):
        raise ValueError("Missing manifest pages/parts")
    digest = hashlib.sha256()
    total = 0
    created = False
    try:
        with output.open("xb") as destination:
            created = True
            for index in range(reference[3]):
                record = records[index]
                name = record["filename"]
                if not isinstance(name, str) or not name or name in (".", "..") or any(c in name for c in '/\\:\x00'):
                    raise ValueError("Unsafe part filename")
                if record["offset"] != total:
                    raise ValueError("Part offset mismatch")
                file = parts / name
                before = file.lstat()
                if file.is_symlink() or not file.is_file() or before.st_nlink != 1:
                    raise ValueError("Part must be an ordinary non-linked file")
                part_hash = hashlib.sha256()
                length = 0
                with file.open("rb") as source:
                    while data := source.read(1024 * 1024):
                        length += len(data)
                        if length > record["length"] or total + len(data) > 100_000_000_000:
                            raise ValueError("Payload size exceeded")
                        part_hash.update(data)
                        digest.update(data)
                        destination.write(data)
                        total += len(data)
                after = file.lstat()
                if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
                    raise ValueError("Part changed during reconstruction")
                if length != record["length"] or part_hash.hexdigest() != record["sha256"]:
                    raise ValueError("Part SHA-256/length mismatch")
            if total != reference[1] or digest.hexdigest() != reference[2]:
                raise ValueError("Whole file SHA-256/length mismatch")
    except BaseException:
        if created:
            output.unlink()
        raise
    return {"taskId": reference[0], "bytes": total, "sha256": digest.hexdigest(), "complete": reference[4], "parts": len(records)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parts", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest-dir", type=Path, help="Non-recursive directory of parts manifest JSON pages")
    parser.add_argument("pages", type=Path, nargs="*")
    args = parser.parse_args()
    if bool(args.manifest_dir) == bool(args.pages):
        parser.error("Specify either --manifest-dir or explicit page files")
    pages = manifest_pages(args.manifest_dir) if args.manifest_dir else args.pages
    print(json.dumps(reconstruct(pages, args.parts, args.output)))
