(function () {
  "use strict";

  var script = document.currentScript;
  var site = script && script.getAttribute("data-site");
  if (!site || !/^as_[A-Za-z0-9]{22}$/.test(site)) return;
  var endpoint = (script && script.getAttribute("data-endpoint")) || "https://analytics.aismallbizguru.com/collect";
  var SESSION_KEY = "cflab.analytics.session";
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  // Privacy first: no cookies, no localStorage, no fingerprinting. The session
  // id lives in sessionStorage only and rotates after 30 minutes of inactivity.
  function privacyOptOut() {
    try {
      if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return true;
      if (navigator.globalPrivacyControl === true) return true;
    } catch (error) {}
    return false;
  }

  function randomToken(prefix) {
    try {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      var out = "";
      for (var i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, "0");
      return prefix + out;
    } catch (error) {
      return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  function sessionId() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.id && typeof parsed.at === "number" && Date.now() - parsed.at < SESSION_IDLE_MS) {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: parsed.id, at: Date.now() }));
          return parsed.id;
        }
      }
      var next = randomToken("s_");
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id: next, at: Date.now() }));
      return next;
    } catch (error) {
      return null;
    }
  }

  // Only UTM parameters are read from the query string; the pathname is sent
  // without the query and the full referrer URL is reduced to a host server-side.
  function utm() {
    var out = {};
    try {
      var params = new URLSearchParams(window.location.search || "");
      var keys = ["source", "medium", "campaign", "content", "term"];
      for (var i = 0; i < keys.length; i += 1) {
        var value = params.get("utm_" + keys[i]);
        if (value) out[keys[i]] = value.slice(0, 200);
      }
    } catch (error) {}
    return out;
  }

  function send(kind, name, props) {
    if (privacyOptOut()) return;
    var session = sessionId();
    if (!session) return;
    var payload = {
      site: site,
      kind: kind,
      name: name,
      path: window.location.pathname,
      session: session,
      event_uid: randomToken("e_"),
      referrer: document.referrer || undefined,
      utm: utm(),
      props: props || undefined
    };
    try {
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      }).catch(function () {});
    } catch (error) {}
  }

  function pageview() {
    send("pageview", "pageview");
  }

  window.cflabAnalytics = {
    track: function (name, props) {
      if (typeof name === "string" && name) send("event", name, props);
    }
  };

  if (document.readyState === "complete") window.setTimeout(pageview, 0);
  else window.addEventListener("load", pageview, { once: true });
}());
