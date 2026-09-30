/* Sign-in is always two steps: the password, then a code from an
   authenticator app. An account with no authenticator yet is made to set one
   up here — there is no path from this page to the roster that skips it.

   Nothing on this page learns anything about the account between the two
   steps. The password step returns only which of the two screens comes next. */
(function () {
  "use strict";

  var tabs  = document.querySelectorAll(".auth-tab");
  var forms = {
    login:  document.getElementById("form-login"),
    signup: document.getElementById("form-signup"),
    mfa:    document.getElementById("form-mfa"),
    enrol:  document.getElementById("form-enrol")
  };
  var recovery = document.getElementById("recovery");
  var errorBox = document.getElementById("auth-error");
  var notice   = document.getElementById("auth-notice");

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function busy(form, on, label) {
    var button = form.querySelector("button[type=submit]");
    button.disabled = on;
    button.textContent = on ? label : button.dataset.label;
  }

  /* One screen at a time. The tab strip belongs to the password step only. */
  function show(which) {
    Object.keys(forms).forEach(function (k) { forms[k].hidden = k !== which; });
    recovery.hidden = true;
    var tabStrip = document.querySelector(".auth-tabs");
    if (tabStrip) tabStrip.hidden = which !== "login" && which !== "signup";
    wide(which === "enrol");
    errorBox.hidden = true;
  }

  /* Enrolment and the recovery codes both need more room than a sign-in form. */
  function wide(on) {
    document.querySelector(".auth-card").classList.toggle("auth-card-wide", on);
  }

  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var mode = tab.dataset.mode;
      tabs.forEach(function (t) { t.classList.toggle("active", t === tab); });
      show(mode);
    });
  });

  if (/(^|[?&])out=1(&|$)/.test(window.location.search)) {
    notice.textContent = "Signed out.";
    notice.hidden = false;
  }

  api("GET", "me").then(function (res) {
    if (res.authenticated) {
      window.location.replace("app.html");
      return;
    }
    if (res.installed === false) {
      window.location.replace("install.html");
      return;
    }

    if (!res.signup) {
      document.querySelector('.auth-tab[data-mode="signup"]').hidden = true;
      document.querySelector(".auth-tabs").hidden = true;
    }

    /* Only offered when the server can actually send the mail. A link to a
       form that always fails is worse than no link. */
    if (res.reset) {
      document.getElementById("forgot-line").hidden = false;
    }
  }).catch(function () {
  });

  Object.keys(forms).forEach(function (k) {
    var button = forms[k].querySelector("button[type=submit]");
    if (button) button.dataset.label = button.textContent;
  });

  /* Both the password step and self-registration land on the same two
     outcomes, so they share the handling of them. */
  function afterPassword(res, email) {
    if (res.mfa === "enroll") {
      document.getElementById("enrol-who").textContent = email;
      document.getElementById("enrol-secret").textContent = res.secret;

      var qr = document.getElementById("enrol-qr");
      qr.setAttribute("data-qr", res.uri);
      try {
        window.qrDraw(qr);
      } catch (e) {
        /* The key is printed above the code either way, so a QR that will not
           draw costs the typing, not the sign-in. */
        qr.innerHTML = '<p class="auth-hint">Could not draw the QR code — ' +
          "use the setup key below.</p>";
      }

      show("enrol");
      document.getElementById("enrol-code").focus();
      return;
    }

    show("mfa");
    document.getElementById("mfa-code").focus();
  }

  /* A pending sign-in that has expired or run out of tries is gone on the
     server, so the only honest thing the page can do is start over. */
  function restartIfTold(err) {
    if (err.data && err.data.restart) {
      show("login");
      showError(err.message);
      return true;
    }
    return false;
  }

  forms.login.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(forms.login, true, "Signing in…");

    var email = new FormData(forms.login).get("email");
    api("POST", "login", {
      email: email,
      password: new FormData(forms.login).get("password")
    })
      .then(function (res) {
        busy(forms.login, false);
        afterPassword(res, email);
      })
      .catch(function (err) {
        busy(forms.login, false);
        showError(err.message);
        var pw = forms.login.querySelector('[name="password"]');
        pw.value = "";
        pw.focus();
      });
  });

  forms.mfa.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(forms.mfa, true, "Checking…");

    api("POST", "login_mfa", { code: new FormData(forms.mfa).get("code") })
      .then(function () {
        window.location.replace("app.html");
      })
      .catch(function (err) {
        busy(forms.mfa, false);
        if (restartIfTold(err)) return;
        showError(err.message);
        var code = document.getElementById("mfa-code");
        code.value = "";
        code.focus();
      });
  });

  forms.enrol.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(forms.enrol, true, "Finishing…");

    api("POST", "login_enrol", { code: new FormData(forms.enrol).get("code") })
      .then(function (res) {
        busy(forms.enrol, false);
        /* Signed in at this point. The codes are shown before going on,
           because this is the only time they exist in readable form. */
        showRecoveryCodes(res.recoveryCodes || []);
      })
      .catch(function (err) {
        busy(forms.enrol, false);
        if (restartIfTold(err)) return;
        showError(err.message);
        var code = document.getElementById("enrol-code");
        code.value = "";
        code.focus();
      });
  });

  function showRecoveryCodes(codes) {
    var box = document.getElementById("recovery-codes");
    box.textContent = "";
    codes.forEach(function (c) {
      var span = document.createElement("span");
      span.textContent = c;
      box.appendChild(span);
    });

    Object.keys(forms).forEach(function (k) { forms[k].hidden = true; });
    var tabStrip = document.querySelector(".auth-tabs");
    if (tabStrip) tabStrip.hidden = true;
    wide(true);
    recovery.hidden = false;
    document.getElementById("recovery-done").focus();
  }

  document.getElementById("recovery-done").addEventListener("click", function () {
    window.location.replace("app.html");
  });

  forms.signup.addEventListener("submit", function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    busy(forms.signup, true, "Creating…");

    var fd = new FormData(forms.signup);
    api("POST", "signup", {
      name:     fd.get("name"),
      email:    fd.get("email"),
      password: fd.get("password"),
      confirm:  fd.get("confirm")
    })
      .then(function (res) {
        busy(forms.signup, false);
        /* A new account is not signed in either — it goes to enrolment. */
        afterPassword(res, fd.get("email"));
      })
      .catch(function (err) {
        busy(forms.signup, false);
        showError(err.message);
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
