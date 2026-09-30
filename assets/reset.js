(function () {
  "use strict";

  var form     = document.getElementById("form-reset");
  var errorBox = document.getElementById("auth-error");
  var notice   = document.getElementById("auth-notice");
  var button   = form.querySelector("button[type=submit]");

  button.dataset.label = button.textContent;

  function busy(on, label) {
    button.disabled = on;
    button.textContent = on ? label : button.dataset.label;
  }

  function fail(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  /* The token never goes anywhere but the request body. Leaving it in the
     address bar would put a live password-reset link into browser history and
     into the referrer of anything this page loaded. */
  var token = new URLSearchParams(window.location.search).get("token") || "";
  if (window.history && window.history.replaceState) {
    window.history.replaceState({}, "", "reset.html");
  }

  if (!/^[a-f0-9]{64}$/.test(token)) {
    fail("That link is not complete. Copy the whole address out of the email, or ask for a new one.");
  } else {
    form.hidden = false;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(true, "Saving…");

    var fd = new FormData(form);
    api("POST", "reset", {
      token:    token,
      password: fd.get("password"),
      confirm:  fd.get("confirm")
    })
      .then(function () {
        form.hidden = true;
        notice.textContent = "Password changed. You can sign in with it now.";
        notice.hidden = false;
        setTimeout(function () { window.location.replace("login.html"); }, 2500);
      })
      .catch(function (err) {
        busy(false);
        fail(err.message);
      });
  });

  var regPw      = document.getElementById("reg-password");
  var regConfirm = document.getElementById("reg-confirm");
  var reqList    = document.getElementById("pw-reqs");
  var matchMsg   = document.getElementById("pw-match");

  var rules = {
    len:     function (v) { return v.length >= 10; },
    upper:   function (v) { return /[A-Z]/.test(v); },
    lower:   function (v) { return /[a-z]/.test(v); },
    number:  function (v) { return /[0-9]/.test(v); },
    special: function (v) { return /[^A-Za-z0-9]/.test(v); }
  };

  function refreshMatch() {
    if (!regConfirm.value) {
      matchMsg.hidden = true;
      return;
    }
    var same = regPw.value === regConfirm.value;
    matchMsg.hidden = false;
    matchMsg.textContent = same ? "Passwords match" : "Passwords do not match";
    matchMsg.classList.toggle("ok", same);
    matchMsg.classList.toggle("bad", !same);
  }

  regPw.addEventListener("input", function () {
    reqList.querySelectorAll("li").forEach(function (li) {
      li.classList.toggle("ok", rules[li.dataset.req](regPw.value));
    });
    refreshMatch();
  });
  regConfirm.addEventListener("input", refreshMatch);
})();
