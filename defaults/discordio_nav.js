// Controller navigation for Discord's web client.
//
// Steam doesn't pass gamepad input into browser views, so the QAM plugin
// catches D-pad / A / B / bumpers on the Steam side and forwards them here.
// This keeps a highlighted "cursor" element and moves it spatially, which
// works on any Discord screen without depending on Discord internals.
(() => {
    const SELECTOR = [
        "button", "a[href]", "input", "textarea", "select",
        "[role=button]", "[role=link]", "[role=treeitem]", "[role=tab]", "[role=option]",
        "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]", "[role=switch]",
        "[role=checkbox]", "[role=radio]", "[role=textbox]", "[contenteditable=true]",
        "[role=listitem][tabindex]", "[tabindex='0']",
    ].join(",");

    let current = null;
    let enabled = false;
    let ring = null;

    const ensureRing = () => {
        if (ring && document.body.contains(ring)) return ring;
        ring = document.createElement("div");
        ring.id = "discordio-nav-ring";
        Object.assign(ring.style, {
            position: "fixed", pointerEvents: "none", zIndex: "2147483647",
            border: "3px solid #5865f2", borderRadius: "8px",
            boxShadow: "0 0 0 2px rgba(255,255,255,0.85), 0 0 18px rgba(88,101,242,0.9)",
            transition: "all 90ms ease-out", display: "none",
        });
        document.body.appendChild(ring);
        return ring;
    };

    const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
        if (el.closest("[aria-hidden=true], [inert]")) return false;
        if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
    };

    // When a popup, menu or modal is open, only navigate inside it.
    const topLayer = () => {
        const layers = [...document.querySelectorAll("[role=dialog], [role=menu], [role=listbox], [class*=popout_], [class*=layer_] [class*=focusLock]")]
            .filter(visible);
        return layers.length ? layers[layers.length - 1] : null;
    };

    const candidates = () => {
        const root = topLayer() || document;
        const seen = new Set();
        return [...root.querySelectorAll(SELECTOR)].filter((el) => {
            if (!visible(el)) return false;
            // Skip elements nested inside another candidate that fully contains them,
            // e.g. a button inside a clickable list row.
            const parent = el.parentElement && el.parentElement.closest(SELECTOR);
            if (parent && seen.has(parent)) return false;
            seen.add(el);
            return true;
        });
    };

    const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

    const draw = () => {
        const ringEl = ensureRing();
        if (!enabled || !current || !document.contains(current)) {
            ringEl.style.display = "none";
            return;
        }
        const r = current.getBoundingClientRect();
        Object.assign(ringEl.style, {
            display: "block",
            left: `${r.left - 4}px`, top: `${r.top - 4}px`,
            width: `${r.width + 8}px`, height: `${r.height + 8}px`,
        });
    };

    const setCurrent = (el) => {
        current = el;
        if (el) {
            try { el.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) { }
            // Lets Discord show its own hover state (tooltips, server names).
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        }
        draw();
    };

    const pickInitial = () => {
        const all = candidates();
        if (!all.length) return null;
        // Prefer whatever Discord itself has focused, then the selected channel,
        // otherwise the element closest to the middle of the screen.
        const focused = document.activeElement && all.find((e) => e === document.activeElement);
        if (focused) return focused;
        const selected = all.find((e) => e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-current") === "page");
        if (selected) return selected;
        const mid = { x: innerWidth / 2, y: innerHeight / 2 };
        return all.reduce((best, el) => {
            const c = center(el.getBoundingClientRect());
            const d = Math.hypot(c.x - mid.x, c.y - mid.y);
            return !best || d < best.d ? { el, d } : best;
        }, null).el;
    };

    const scrollableParent = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
        }
        return null;
    };

    const move = (dir) => {
        if (!current || !document.contains(current) || !visible(current)) {
            setCurrent(pickInitial());
            return true;
        }
        const from = center(current.getBoundingClientRect());
        const vertical = dir === "up" || dir === "down";
        const sign = dir === "up" || dir === "left" ? -1 : 1;
        let best = null;
        for (const el of candidates()) {
            if (el === current || el.contains(current) || current.contains(el)) continue;
            const c = center(el.getBoundingClientRect());
            const primary = (vertical ? c.y - from.y : c.x - from.x) * sign;
            const secondary = Math.abs(vertical ? c.x - from.x : c.y - from.y);
            if (primary < 4) continue;
            const score = primary + secondary * 2.5;
            if (!best || score < best.score) best = { el, score };
        }
        if (best) {
            setCurrent(best.el);
            return true;
        }
        // Nothing further that way: scroll the list we're in, if any.
        if (vertical) {
            const sc = scrollableParent(current);
            if (sc) {
                sc.scrollBy({ top: sign * sc.clientHeight * 0.6, behavior: "smooth" });
                setTimeout(draw, 250);
                return true;
            }
        }
        return false;
    };

    const openKeyboard = () => fetch("http://127.0.0.1:65123/openkb", { mode: "no-cors" }).catch(() => { });

    const isTextField = (el) =>
        el.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, [role=textbox], [contenteditable=true]");

    const select = () => {
        if (!current || !document.contains(current)) {
            setCurrent(pickInitial());
            return true;
        }
        const el = current;
        if (isTextField(el)) {
            el.focus();
            openKeyboard();
            return true;
        }
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.focus && el.focus();
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.click();
        // Whatever was clicked may have opened a popup or changed the page.
        setTimeout(() => { if (!document.contains(current) || topLayer()) setCurrent(pickInitial()); else draw(); }, 300);
        return true;
    };

    const key = (k, code, keyCode, mods = {}) => {
        const target = document.activeElement || document.body;
        const init = { key: k, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...mods };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
    };

    const back = () => {
        if (topLayer()) {
            key("Escape", "Escape", 27);
            setTimeout(() => setCurrent(pickInitial()), 250);
            return true;
        }
        return false; // the plugin closes the Discord view
    };

    const scroll = (sign) => {
        const sc = (current && scrollableParent(current)) ||
            [...document.querySelectorAll("[class*=scroller]")].filter(visible).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
        if (!sc) return false;
        sc.scrollBy({ top: sign * sc.clientHeight * 0.8, behavior: "smooth" });
        setTimeout(draw, 300);
        return true;
    };

    window.DISCORDIO_NAV = (action) => {
        switch (action) {
            case "show-highlight": enabled = true; if (!current) current = pickInitial(); draw(); return { handled: true };
            case "hide-highlight": enabled = false; draw(); return { handled: true };
            case "up": case "down": case "left": case "right":
                enabled = true; return { handled: move(action) };
            case "select": enabled = true; return { handled: select() };
            case "back": return { handled: back() };
            case "scroll-up": return { handled: scroll(-1) };
            case "scroll-down": return { handled: scroll(1) };
            case "quick-switcher":
                key("k", "KeyK", 75, { ctrlKey: true });
                setTimeout(() => { setCurrent(pickInitial()); openKeyboard(); }, 300);
                return { handled: true };
            case "prev-server": key("ArrowUp", "ArrowUp", 38, { ctrlKey: true, altKey: true }); return { handled: true };
            case "next-server": key("ArrowDown", "ArrowDown", 40, { ctrlKey: true, altKey: true }); return { handled: true };
        }
        return { handled: false, error: "unknown action " + action };
    };

    // Keep the highlight glued to its element as Discord re-renders and scrolls.
    addEventListener("scroll", draw, true);
    addEventListener("resize", draw);
    // Using the mouse moves the highlight to what was clicked.
    addEventListener("mousedown", (e) => {
        if (!e.isTrusted) return;
        const el = e.target.closest && e.target.closest(SELECTOR);
        if (el) { current = el; draw(); }
    }, true);
})();
