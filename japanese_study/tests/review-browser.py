"""Drive the built MCP resource through SDK HTTP and an iframe Host, with synthetic data."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import socket
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from contextlib import closing

import uvicorn
from playwright.sync_api import sync_playwright, expect


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mcp-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--benchmark", choices=["before", "after"])
    args = parser.parse_args()
    sys.path.insert(0, str(args.hub_root.resolve() / "src"))
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="jstudy-review-test-") as temporary:
        data = Path(temporary)
        # Also protect historical baselines whose api import initializes the configured DB.
        os.environ["JSTUDY_DATA_DIR"] = str(data)
        os.environ["JSTUDY_DB_PATH"] = str(data / "study.db")
        os.environ["JSTUDY_API_HOST"] = "127.0.0.1"
        from japanese_study_hub.api import create_app
        from japanese_study_hub.config import Settings
        from japanese_study_hub.repository import StudyRepository

        repo = StudyRepository(data / "study.db")
        items = []
        for kind, count in [("vocab", 1041), ("grammar", 51)]:
            for index in range(count):
                title = ("試験" if kind == "vocab" else "文法") + f"{index:04}"
                items.append({
                    "item_id": f"{kind}:test-{index:04}", "kind": kind,
                    "canonical_key": json.dumps([title, "test"] if kind == "grammar" else [title, "しけん", "noun"]),
                    "title": title, "reading": "しけん", "meaning_tc": f"測試{kind} {index:04}",
                    "jlpt_level": "N3", "part_of_speech": "名詞",
                    "source_name": "synthetic", "source_ref": f"{kind}:{index}", "source_version": "1",
                    "content": {
                        "explanation": "測試用長說明" * (100 if kind == "grammar" else 15),
                        "forms": [{"syntax": "名詞＋にしては"}], "nuance": "與預期不同",
                        "examples": [{"ja": "試験を受ける。", "zh_tw": "參加考試。"}],
                        "source_details": {"long_explanation_en": "source detail " * 100},
                    },
                })
        items[0]["title"] = '<img src=x onerror="window.pwned=1">'
        items[1]["meaning_tc"] = ""
        items[2]["content"]["review_status"] = "needs_translation_and_content_review"
        for index in (3, 903):
            items[index]["jlpt_level"] = "N2"
        items[1038]["jlpt_level"] = ""
        items[1039]["jlpt_level"] = "custom"
        items[1040]["jlpt_level"] = "N4-5"
        items[1040]["part_of_speech"] = ""
        repo.upsert_items(items)
        repo.set_manual_labels([
            {"item_id": "vocab:test-0000", "label": "unknown", "note": "保留原有筆記"},
            {"item_id": "vocab:test-0002", "label": "uncertain"},
            {"item_id": "vocab:test-0003", "label": "known"},
            {"item_id": "vocab:test-0004", "label": "suspended"},
        ])
        for index in range(5, 123):
            repo.record_attempt({"event_id": f"test-prior-{index:04}", "item_id": f"vocab:test-{index:04}",
                                 "result": "again", "occurred_at": "2026-01-01T00:00:00+00:00", "source": "synthetic"})
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        settings = Settings(data, data / "study.db", "127.0.0.1", listener.getsockname()[1], None)
        app = create_app(settings)
        hub_calls = []

        async def observed(scope, receive, send):
            started = time.perf_counter()
            metric = {"path": scope.get("path"), "bytes": 0, "status": None}
            async def measure(message):
                if message["type"] == "http.response.start":
                    metric["status"] = message["status"]
                elif message["type"] == "http.response.body":
                    metric["bytes"] += len(message.get("body", b""))
                await send(message)
            await app(scope, receive, measure)
            if scope["type"] == "http":
                metric["ms"] = (time.perf_counter() - started) * 1000
                hub_calls.append(metric)

        server = uvicorn.Server(uvicorn.Config(observed, log_level="error", access_log=False))
        thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        if not server.started:
            raise RuntimeError("Isolated Hub did not start")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        node = subprocess.Popen(["node", str(args.mcp_root.resolve() / "tests/review-host.mjs"),
                                 f"http://127.0.0.1:{settings.api_port}"], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8", creationflags=flags)
        try:
            line = node.stdout.readline()
            if not line:
                raise RuntimeError("Test host failed: " + node.stderr.read()[:1000])
            url = json.loads(line)["url"]

            def control(**values):
                request = urllib.request.Request(url + "/control", json.dumps(values).encode(), {"Content-Type": "application/json"})
                with urllib.request.urlopen(request, timeout=5) as response:
                    response.read()

            def calls():
                with urllib.request.urlopen(url + "/calls", timeout=5) as response:
                    return json.load(response)

            def events():
                with closing(sqlite3.connect(settings.db_path)) as connection:
                    return connection.execute("SELECT event_id, item_id, result FROM attempt_events ORDER BY rowid").fetchall()

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch()
                if args.benchmark:
                    benchmark(browser, url, args, calls, hub_calls, settings.db_path)
                else:
                    acceptance(browser, url, args, repo, control, calls, events)
                browser.close()
        finally:
            node.terminate()
            try:
                node.wait(timeout=5)
            except subprocess.TimeoutExpired:
                node.kill()
                node.wait(timeout=5)
            server.should_exit = True
            thread.join(timeout=5)
            listener.close()


def acceptance(browser, url, args, repo, control, calls, events):
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.add_init_script("""(() => {
      if (location.pathname !== '/app') return;
      const key = 'isolated-review-widget';
      window.openai = {
        get widgetState() { return JSON.parse(sessionStorage.getItem(key) ?? 'null'); },
        setWidgetState(state) { sessionStorage.setItem(key, JSON.stringify(state)); },
      };
    })()""")
    errors = []
    filter_layouts = []
    sessions = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    frame = page.frame_locator("#app")
    loc = frame.locator
    rows = loc("#js-rows tr")
    event_count = len(events())
    mark_positions = []
    expect(rows).to_have_count(50)
    expect(loc("#js-rows img")).to_have_count(0)
    assert page.frames[1].evaluate("window.pwned") is None
    expect(loc("#js-result-count")).to_have_text("1–50 / 1041")
    expect(loc("#js-page-total")).to_have_text("共 21 頁")
    loc("#js-next").click()
    expect(loc("#js-result-count")).to_have_text("51–100 / 1041")
    loc("#js-prev").click()
    expect(loc("#js-result-count")).to_have_text("1–50 / 1041")

    def jump20():
        loc("#js-page-number").fill("20")
        loc("#js-page-number").press("Enter")
        expect(loc("#js-result-count")).to_contain_text("951–1000")
        return rows.nth(16)

    def mark(row, rating, message, expected_focus, lost_reply=False):
        select = row.locator("select")
        select.focus()
        assert loc("#js-scroll").evaluate("el=>el.scrollTop") > 100
        before = select.evaluate("el=>el.closest('tr').getBoundingClientRect().top")
        page.frames[1].evaluate("window.retainedRow=document.querySelector('#js-rows tr')")
        if lost_reply:
            select.evaluate("""el => {
              const row = el.closest('tr'), scroll = document.querySelector('#js-scroll');
              window.markTrace = [];
              const record = label => window.markTrace.push({
                label, top: row.getBoundingClientRect().top,
                relative: row.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
                scroll: scroll.scrollTop, header: document.querySelector('thead').getBoundingClientRect().height,
                detail: row.dataset.detail, focus: document.activeElement?.outerHTML.slice(0,125)
              });
              record('before');
              scroll.addEventListener('scroll', () => record('scroll'));
              document.addEventListener('change', () => record('change'), true);
              document.addEventListener('focusin', () => record('focusin'));
              new MutationObserver(() => record('content')).observe(document.querySelector('#js-rows'),
                {childList:true,subtree:true});
            }""")
        start = len(calls())
        if lost_reply:
            control(loseLabelReply=True)
        select.select_option(rating)
        if lost_reply:
            expect(loc("#js-retry")).to_have_text("重新讀取結果")
            loc("#js-retry").click()
        expect(loc("#js-operation-text")).to_have_text(message)
        expect(loc("#js-rows select:focus")).to_have_attribute("aria-label", expected_focus + "的熟悉度")
        assert loc("#js-scroll").evaluate("el=>el.scrollTop") > 100
        after = loc("#js-rows select:focus").evaluate("el=>el.closest('tr').getBoundingClientRect().top")
        assert abs(after - before) < 24, (before, after, page.frames[1].evaluate("window.markTrace"))
        mark_positions.append({"lost_reply": lost_reply, "before_y": before, "after_y": after,
                               "absolute_delta_px": round(abs(after - before), 2)})
        if lost_reply:
            (args.output / "anchor-after.json").write_text(json.dumps(
                page.frames[1].evaluate("window.markTrace"), ensure_ascii=False, indent=2), encoding="utf-8")
        assert page.frames[1].evaluate("window.retainedRow===document.querySelector('#js-rows tr')")
        relevant = [entry["name"] for entry in calls()[start:] if entry["name"] != "study_update_review_workspace"]
        assert relevant.count("study_set_manual_labels") == 1, relevant
        assert relevant.count("study_get_item") == int(lost_reply), relevant

    row = jump20()
    anchor = row.get_attribute("data-item")
    word = row.locator(".js-word").inner_text()
    mark(row, "known", "已儲存：熟悉", word, lost_reply=True)
    expect(row).to_have_attribute("data-familiarity", "known")
    page.wait_for_function("""async () => {
      const app = document.querySelector('#app').contentWindow;
      const value = await app.StudyBridge.call('study_read_review_workspace', {scope:'workspace'});
      return value.bookmark?.item_id === %s;
    }""" % json.dumps(anchor))
    page.reload()
    expect(loc("#js-result-count")).to_have_text("951–1000 / 1041")
    expect(loc("#js-status")).to_have_text("已接續上次閱讀。")
    assert rows.nth(16).get_attribute("data-item") == anchor
    assert loc("#js-scroll").evaluate("el=>el.scrollTop") > 100

    loc("#js-label-filter").select_option("unmarked")
    row = jump20()
    successor = rows.nth(17).get_attribute("data-item")
    word = rows.nth(17).locator(".js-word").inner_text()
    mark(row, "known", "已儲存：熟悉", word)
    expect(loc("#js-result-count")).to_have_text("951–1000 / 1035")
    expect(loc("#js-status")).to_contain_text("已移到鄰近")
    page.wait_for_function("""async () => {
      const app = document.querySelector('#app').contentWindow;
      return (await app.StudyBridge.call('study_read_review_workspace', {scope:'workspace'})).bookmark?.item_id === %s;
    }""" % json.dumps(successor))
    page.reload()
    expect(loc("#js-result-count")).to_have_text("951–1000 / 1035")
    assert rows.nth(16).get_attribute("data-item") == successor
    assert loc("#js-scroll").evaluate("el=>el.scrollTop") > 100

    for label, total in [("known", 3), ("unknown", 1), ("uncertain", 1), ("all", 1041)]:
        loc("#js-label-filter").select_option(label)
        expect(loc("#js-result-count")).to_contain_text(" / " + str(total))
    loc('[data-item="vocab:test-0000"] select').select_option("known")
    expect(loc("#js-operation-text")).to_have_text("已儲存：熟悉")
    assert repo.get_item("vocab:test-0000")["manual_note"] == "保留原有筆記"
    loc("#js-level").select_option("N4-5")
    expect(rows).to_have_count(1)
    expect(rows.first).to_have_attribute("data-item", "vocab:test-1040")
    loc("#js-level").select_option("all")
    loc("#js-query").fill("遅い")
    page.wait_for_timeout(310)
    loc("#js-query").fill("測試vocab 0010")
    expect(rows).to_have_count(1)
    expect(rows.first).to_have_attribute("data-item", "vocab:test-0010")
    page.wait_for_timeout(850)
    expect(rows.first).to_have_attribute("data-item", "vocab:test-0010")
    loc("#js-query").fill("查無此項")
    expect(loc("#js-no-results")).to_be_visible()
    loc("#js-query").fill("")
    expect(rows).to_have_count(50)
    expect(rows.first.locator(".js-example")).to_contain_text("參加考試。")
    calls_for_details = [entry for entry in calls() if entry["arguments"].get("scope") == "items"]
    assert calls_for_details and all(1 <= len(entry["arguments"]["itemIds"]) <= 12 for entry in calls_for_details)

    expect(rows.first.locator(".js-meaning")).to_have_count(1)
    expect(rows.first.locator("summary")).to_have_count(0)
    loc("#js-hide").check()
    for value in ["試験を受ける。", "參加考試。"]:
        expect(rows.first.get_by_text(value, exact=True)).to_be_hidden()
    expect(rows.first.locator(".js-meaning")).to_be_hidden()
    loc("#js-hide").uncheck()
    for value in ["試験を受ける。", "參加考試。"]:
        expect(rows.first.get_by_text(value, exact=True)).to_be_visible()
    assert rows.first.evaluate("""row => {
      const meaning = row.querySelector('.js-meaning').getBoundingClientRect();
      const example = row.querySelector('.js-example').getBoundingClientRect();
      return meaning.bottom <= example.top && example.bottom <= row.getBoundingClientRect().bottom;
    }""")
    assert len(events()) == event_count
    page.screenshot(path=str(args.output / "library-light.png"), full_page=True)

    loc("#js-level").select_option("N4-5")
    loc("#js-label-filter").select_option("unmarked")
    loc("#js-query").fill("1040")
    expect(rows).to_have_count(1)
    expect(rows.first).to_have_attribute("data-item", "vocab:test-1040")
    loc("#js-use-list").click()
    expect(loc("#js-card-levels summary")).to_contain_text("N4-5")
    expect(loc("#js-card-labels summary")).to_contain_text("未標記")
    expect(loc("#js-review-status")).to_contain_text("文字搜尋僅適用於教材清單")
    loc('[data-page="library"]').click()
    expect(loc("#js-level")).to_have_value("N4-5")
    expect(loc("#js-query")).to_have_value("1040")
    assert repo.review_workspace()["bookmark"]["item_id"] == "vocab:test-1040"
    loc("#js-level").select_option("all")
    loc("#js-label-filter").select_option("all")
    loc("#js-query").fill("")
    expect(rows).to_have_count(50)
    loc("#js-use-list").click()
    for menu in ["card-levels", "card-labels"]:
        expect(loc(f"#js-{menu} summary")).to_contain_text("全部")

    def installed_deck():
        return next(deck for deck in repo.review_workspace()["decks"] if deck["config"]["mode"] == "random")

    def check_filters(stage):
        locators = [loc("#js-card-levels summary"), loc("#js-card-labels summary"), loc("#js-direction")]
        for field in locators:
            expect(field).to_be_visible()
        boxes = loc("#js-cards .js-review-options").evaluate("""grid =>
          Array.from(grid.children, field => {
            const box = field.querySelector('.js-round-control').getBoundingClientRect();
            const title = field.querySelector('.js-round-label').getBoundingClientRect();
            const value = field.querySelector('.js-filter-value')?.getBoundingClientRect() ?? box;
            return {x:box.x,y:box.y,width:box.width,height:box.height,titleY:title.y,titleX:title.x,
                    valueCenterY:value.y + value.height / 2};
          })""")
        for axis in ("y", "width", "height", "titleY", "valueCenterY"):
            values = [box[axis] for box in boxes]
            assert max(values) - min(values) <= 1, (stage, axis, boxes)
        assert all(abs(box["x"] - box["titleX"]) <= 1 and box["height"] >= 44 for box in boxes), boxes
        assert page.frames[1].evaluate("document.documentElement.scrollWidth <= innerWidth")
        filter_layouts.append({"stage": stage, "viewport": page.viewport_size["width"], "boxes": boxes})

    def check_card():
        expect(loc("#js-card-progress, [role=progressbar], #js-resume")).to_have_count(0)
        expect(loc("article.js-flash:visible")).to_have_count(1)
        expect(loc("#js-reveal")).to_be_enabled()
        expect(loc("#js-answer")).to_have_text("")
        expect(loc("#js-answer")).to_be_hidden()
        expect(loc("#js-rating")).to_be_hidden()
        expect(loc("#js-setup")).to_be_hidden()
        assert loc("#js-round-actions").evaluate("""actions => {
          const [pause, skip] = actions.querySelectorAll('button');
          const card = document.querySelector('.js-flash').getBoundingClientRect();
          return pause.getBoundingClientRect().top >= card.bottom &&
            Math.abs(pause.getBoundingClientRect().top - skip.getBoundingClientRect().top) < 1;
        }""")

    def check_answer(stage, has_part_of_speech=True, reverse=False):
        loc("#js-reveal").press("Enter")
        answer = loc("#js-answer")
        expect(answer).to_be_focused()
        expect(answer.locator(".js-reading")).to_have_text("しけん")
        expect(answer.locator(".js-meaning")).to_be_visible()
        if reverse:
            expect(answer.locator("h3")).to_be_visible()
        if has_part_of_speech:
            expect(answer.locator(".js-answer-pos")).to_have_text("詞性 名詞")
        else:
            expect(answer.locator(".js-answer-pos")).to_have_count(0)
        for value in ["與預期不同", "試験を受ける。", "參加考試。"]:
            expect(answer.get_by_text(value, exact=value != "與預期不同")).to_be_visible()
        expect(answer.locator("details, summary")).to_have_count(0)
        expect(loc("#js-rating button")).to_have_count(4)
        assert answer.evaluate("""element => {
          const head = element.querySelector('.js-answer-head').getBoundingClientRect();
          const centered = ['.js-reading', '.js-meaning'].every(selector => {
            const child = element.querySelector(selector).getBoundingClientRect();
            return Math.abs(child.x + child.width / 2 - head.x - head.width / 2) <= 1;
          });
          return centered && element.querySelector('.js-answer-detail').getBoundingClientRect().bottom <=
            document.querySelector('#js-rating').getBoundingClientRect().top;
        }"""), stage
        check_filters(stage)

    def screenshot_card(filename):
        # The synthetic Host uses a fixed iframe. Expand it only for the evidence image.
        height = page.frames[1].evaluate("document.querySelector('#jstudy-app').getBoundingClientRect().height")
        host_frame = page.locator("#app")
        previous = host_frame.evaluate("(el, height) => { const before = el.style.height; el.style.height = Math.ceil(height) + 'px'; return before; }",
                                      max(height, 900))
        try:
            page.screenshot(path=str(args.output / filename), full_page=True)
        finally:
            host_frame.evaluate("(el, before) => el.style.height = before", previous)

    def start_round(stage):
        loc("#js-start").click()
        check_card()
        check_filters(stage)
        deck = installed_deck()
        assert deck["position"] == 0, deck
        assert deck["session_id"] not in sessions, deck
        sessions.append(deck["session_id"])
        return deck

    check_filters("desktop-ready")
    first = start_round("desktop-card")
    assert first["total"] == 1038
    assert first["config"]["jlpt_levels"] is None and first["config"]["manual_labels"] is None

    # Draft preferences stay visible and editable, and never change the installed deck.
    cue = loc("#js-card-prompt").inner_text()
    loc("#js-direction").select_option("zh")
    expect(loc("#js-deck-summary")).to_contain_text("日文 → 中文")
    expect(loc("#js-deck-summary")).to_contain_text("套用到下一輪")
    expect(loc("#js-card-prompt")).to_have_text(cue)
    assert installed_deck()["config"] == first["config"]
    check_filters("desktop-active-draft")
    loc("#js-skip").click()
    check_card()
    assert installed_deck()["position"] == 1
    assert len(events()) == event_count
    check_answer("desktop-answer")
    # Keyboard moves from the revealed answer to the first grade.
    loc("#js-answer").press("Tab")
    expect(loc('[data-rate="again"]')).to_be_focused()
    screenshot_card("cards-light.png")
    control(loseAttemptReply=True)
    loc('[data-rate="hard"]').click()
    expect(loc("#js-retry")).to_have_text("重新讀取結果")
    expect(loc("#js-end")).to_be_disabled()
    expect(loc("#js-skip")).to_be_disabled()
    assert len(events()) == event_count + 1
    control(failReadback=True)
    loc("#js-retry").click()
    expect(loc("#js-operation-text")).to_contain_text("injected read failure")
    loc("#js-retry").click()
    check_card()
    assert installed_deck()["position"] == 2
    moves = [call for call in calls() if call["name"] == "study_update_review_workspace" and
             call["arguments"]["change"]["action"] == "move"]
    assert len(moves) == 2
    assert len(events()) == event_count + 1 and events()[-1][2] == "hard"
    for grade in ["again", "correct"]:
        loc("#js-reveal").click()
        loc(f'[data-rate="{grade}"]').click()
        expect(loc("#js-operation-text")).to_have_text("已記錄")
        check_card()

    # A reopened Host may retain an exact pending attempt. Resolve it without showing an old card.
    loc("#js-reveal").click()
    control(loseAttemptReply=True)
    loc('[data-rate="easy"]').click()
    expect(loc("#js-retry")).to_have_text("重新讀取結果")
    assert len(events()) == event_count + 4
    lost_move = installed_deck()["last_move"]["move"]
    before_reload = len(calls())
    page.reload()
    expect(loc("#js-cards")).to_be_visible()
    expect(loc("#js-retry")).to_have_text("重新讀取結果")
    expect(loc("#js-start")).to_be_disabled()
    expect(loc("#js-session")).to_be_hidden()
    loc("#js-retry").click()
    expect(loc("#js-operation-text")).to_have_text("已記錄")
    expect(loc("#js-start")).to_be_enabled()
    expect(loc("#js-session")).to_be_hidden()
    exact = [call for call in calls()[before_reload:] if call["arguments"].get("scope") == "deck"]
    assert len(exact) == 1 and exact[0]["arguments"]["sessionId"] == lost_move["session_id"], exact
    assert not any(call["arguments"].get("change", {}).get("action") == "move" for call in calls()[before_reload:])
    assert len(events()) == event_count + 4
    assert installed_deck()["position"] == 5
    saved_attempts = {row[0]: repo.get_item(row[1])["srs"] for row in events()[event_count:]}

    # Starting and pausing with identical preferences still creates different session IDs.
    after_reopen = start_round("desktop-new-after-reopen")
    assert after_reopen["config"]["direction"] == "zh"
    loc("#js-end").press("Enter")
    expect(loc("#js-start")).to_be_enabled()
    expect(loc("#js-start")).to_be_focused()
    assert installed_deck()["position"] == 0
    after_pause = start_round("desktop-new-after-pause")
    assert after_pause["config"] == after_reopen["config"]
    page.reload()
    expect(loc("#js-cards")).to_be_visible()
    expect(loc("#js-session")).to_be_hidden()
    expect(loc("#js-start")).to_be_enabled()
    assert installed_deck()["session_id"] == after_pause["session_id"]
    assert len(events()) == event_count + 4

    level_menu = loc("#js-card-levels")
    level_menu.locator("summary").press("Enter")
    all_levels = level_menu.get_by_label("全選")
    all_levels.press("Space")
    expect(loc("#js-start")).to_be_disabled()
    expect(loc("#js-deck-summary")).to_contain_text("至少一項")
    expect(loc("#js-resume")).to_have_count(0)
    level_menu.get_by_role("checkbox", name="N2", exact=True).check()
    level_menu.get_by_role("checkbox", name="N3", exact=True).check()
    expect(all_levels).to_have_js_property("indeterminate", True)
    level_menu.get_by_role("checkbox", name="N3", exact=True).press("Escape")
    expect(level_menu.locator("summary")).to_be_focused()
    assert level_menu.get_attribute("open") is None
    label_menu = loc("#js-card-labels")
    label_menu.locator("summary").click()
    label_menu.get_by_label("全選").uncheck()
    expect(loc("#js-start")).to_be_disabled()
    label_menu.get_by_role("checkbox", name="未標記", exact=True).check()
    label_menu.get_by_role("checkbox", name="熟悉", exact=True).check()
    expect(loc("#js-start")).to_be_enabled()
    expect(loc("#js-resume")).to_have_count(0)
    loc("#js-direction").select_option("zh")

    page.wait_for_function("""async () => {
      const app = document.querySelector('#app').contentWindow;
      const result = await app.StudyBridge.call('study_read_review_workspace', {scope:'workspace'});
      const saved = result.card_preferences.vocab;
      return saved?.jlpt_levels?.join(',') === 'N2,N3' && saved?.manual_labels?.join(',') === 'known,unmarked' &&
        saved?.direction === 'zh';
    }""")
    page.reload()
    expect(loc("#js-cards")).to_be_visible()
    expect(loc("#js-card-levels summary")).to_contain_text("N2、N3")
    expect(loc("#js-card-labels summary")).to_contain_text("未標記、熟悉")
    expect(loc("#js-direction")).to_have_value("zh")
    expect(loc("#js-session")).to_be_hidden()
    deck = start_round("desktop-multiselect")
    assert deck["config"]["jlpt_levels"] == ["N2", "N3"]
    assert deck["config"]["manual_labels"] == ["known", "unmarked"]
    assert deck["total"] == 1035
    check_answer("desktop-reverse-answer", reverse=True)
    loc("#js-end").click()

    # One exact level yields a usable singleton. Its absent part of speech stays absent.
    level_menu.locator("summary").click()
    all_levels.click()  # Indeterminate -> all.
    all_levels.uncheck()
    level_menu.get_by_role("checkbox", name="N4-5", exact=True).check()
    level_menu.get_by_role("checkbox", name="N4-5", exact=True).press("Escape")
    singleton = start_round("desktop-singleton")
    assert singleton["total"] == 1
    check_answer("desktop-no-part-of-speech", has_part_of_speech=False, reverse=True)
    loc("#js-skip").click()
    expect(loc("#js-complete")).to_contain_text("略過 1")
    expect(loc("#js-start")).to_be_enabled()
    again = start_round("desktop-new-after-completion")
    assert again["config"] == singleton["config"]
    loc("#js-end").click()
    for event_id, item_id, _ in events()[event_count:]:
        assert repo.get_item(item_id)["srs"] == saved_attempts[event_id]
    assert len(events()) == event_count + 4

    loc('[data-page="library"]').click()
    loc('[data-kind="grammar"]').click()
    expect(rows).to_have_count(50)
    expect(rows.first.locator(".js-example")).to_contain_text("參加考試。")
    expect(rows.first.get_by_text("與預期不同")).to_be_hidden()
    rows.first.locator("summary").press("Enter")
    expect(rows.first.get_by_text("名詞＋にしては")).to_be_visible()
    expect(rows.first.locator(".js-meaning")).to_have_count(1)
    expect(rows.first).to_contain_text("與預期不同")
    page.evaluate("localStorage.theme='dark'")
    page.set_viewport_size({"width": 390, "height": 844})
    page.reload()
    expect(rows).to_have_count(50)
    assert page.frames[1].evaluate("document.documentElement.scrollWidth<=innerWidth")
    assert loc("#jstudy-app").evaluate("el=>getComputedStyle(el).backgroundColor") == "rgb(32, 33, 34)"
    page.screenshot(path=str(args.output / "grammar-dark-mobile.png"), full_page=True)
    loc('[data-page="cards"]').click()
    check_filters("mobile-ready")
    loc("#js-card-levels summary").press("Enter")
    expect(loc("#js-card-levels").get_by_role("checkbox", name="未分類", exact=True)).to_be_visible()
    loc("#js-card-levels").get_by_role("checkbox", name="N1", exact=True).uncheck()
    check_filters("mobile-open-long-selection")
    bounds = loc("#js-card-levels summary").evaluate("""el => {
      const control = el.getBoundingClientRect();
      const value = el.querySelector('.js-filter-value').getBoundingClientRect();
      return value.top >= control.top && value.bottom <= control.bottom && value.right <= control.right;
    }""")
    assert bounds
    page.screenshot(path=str(args.output / "filters-dark-mobile.png"), full_page=True)
    loc("#js-card-levels").get_by_role("checkbox", name="N1", exact=True).press("Escape")
    expect(loc("#js-card-levels summary")).to_be_focused()
    start_round("mobile-active")
    check_answer("mobile-answer")
    screenshot_card("cards-dark-mobile.png")
    loc("#js-end").click()
    expect(loc("#js-start")).to_be_enabled()

    assert not errors, errors
    assert len(events()) == event_count + 4
    result = {"ok": True, "free_pool": first["total"], "multi_filter_pool": deck["total"],
              "confirmed_grades": [row[2] for row in events()[event_count:]], "marks": mark_positions,
              "new_sessions": sessions, "filter_layouts": filter_layouts, "browser_errors": errors}
    (args.output / "acceptance.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


def benchmark(browser, url, args, calls, hub_calls, db):
    records = {}
    before = args.benchmark == "before"
    page = browser.new_page(viewport={"width": 1100, "height": 900})
    page.add_init_script("""(() => {
      const targets = ['js-rows', 'js-card-prompt'];
      window.reviewDom = {};
      new MutationObserver(records => {
        for (const id of targets) {
          const target = document.getElementById(id);
          if (!target || !records.some(record => target.contains(record.target))) continue;
          const start = performance.now();
          requestAnimationFrame(() => window.reviewDom[id] = performance.now() - start);
        }
      }).observe(document, {subtree:true, childList:true, characterData:true, attributes:true});
    })()""")
    loc = page.frame_locator("#app").locator

    def measure(name, action, done, settle=450):
        # Let writes from the previous operation settle, to isolate call attribution.
        page.wait_for_timeout(settle)
        if len(page.frames) > 1:
            page.frames[1].evaluate("window.reviewDom = {}")
        h, m = len(hub_calls), len(calls())
        started = time.perf_counter()
        action()
        done()
        latency = (time.perf_counter() - started) * 1000
        page.wait_for_timeout(settle)
        hub, mcp = hub_calls[h:], calls()[m:]
        selector = 'js-card-prompt' if name in ('first_random_card', 'grade_to_next') else 'js-rows'
        dom_ms = page.frames[1].evaluate("id => window.reviewDom[id] ?? null", selector)
        records.setdefault(name, []).append({
            "ms": latency, "dom_to_frame_ms": dom_ms, "hub_calls": len(hub), "mcp_calls": len(mcp),
            "hub_bytes": sum(call["bytes"] for call in hub),
            "mcp_bytes": sum(call["responseBytes"] for call in mcp),
            "errors": sum(call["status"] >= 400 for call in hub) + sum(call["status"] != "ok" for call in mcp),
            "hub_routes": [call["path"] for call in hub], "mcp_tools": [call["name"] for call in mcp],
            "hub_ms": sum(call["ms"] for call in hub), "mcp_ms": sum(call["ms"] for call in mcp),
            "summary_bytes": sum(call["responseBytes"] for call in mcp
                                 if call["arguments"].get("scope") == "workspace" and call["arguments"].get("library")),
            "detail_items": sum(len(call["arguments"].get("itemIds", [])) or int(call["name"] == "study_get_item")
                                for call in mcp),
        })

    for _ in range(6):
        with closing(sqlite3.connect(db)) as connection, connection:
            connection.execute("DELETE FROM review_bookmark")
            connection.execute("DELETE FROM review_deck")
        rows = loc("#js-rows tr")

        def open_with_examples():
            page.goto(url)
            expect(rows).to_have_count(50)
            if before:
                rows.first.locator("summary").click()

        measure("first_example", open_with_examples,
                lambda: expect(rows.first.locator(".js-example")).to_contain_text("參加考試。"))
        loc('[data-page="cards"]').click()
        measure("first_random_card", lambda: loc("#js-start").click(),
                lambda: expect(loc("#js-reveal")).to_be_enabled())
        loc("#js-reveal").click()
        prompt = loc("#js-card-prompt").inner_text()
        measure("grade_to_next", lambda: loc('[data-rate="correct"]').click(),
                lambda: (expect(loc("#js-card-prompt")).not_to_have_text(prompt), expect(loc("#js-reveal")).to_be_enabled()))

    def summarize(samples):
        result = {}
        for metric in ["ms", "dom_to_frame_ms", "hub_calls", "mcp_calls", "hub_bytes", "mcp_bytes", "hub_ms", "mcp_ms", "errors", "summary_bytes", "detail_items"]:
            values = sorted(sample[metric] for sample in samples if sample[metric] is not None)
            if not values:
                continue
            result[metric] = {"p50": round(statistics.median(values), 2), "p95": round(values[math.ceil(.95 * len(values)) - 1], 2)}
        return result

    result = {"samples": records, "summary": {name: summarize(samples) for name, samples in records.items()}}
    (args.output / f"benchmark-{args.benchmark}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["summary"]))


if __name__ == "__main__":
    main()
