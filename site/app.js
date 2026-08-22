const root = document.documentElement;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function typingDelay() {
  return 55 + (Math.random() * 30 - 15);
}

function railTo(terminal, row) {
  const output = terminal.querySelector(".clack-output");
  const rail = output?.querySelector(".clack-rail");
  const glyph = row?.querySelector(".clack-glyph");
  if (!output || !rail || !glyph) return;
  rail.style.height = `${row.offsetTop + glyph.getBoundingClientRect().height / 2 - parseFloat(getComputedStyle(rail).top)}px`;
}

function animateTerminal() {
  const terminal = document.querySelector("[data-server-cli]");
  const typed = terminal?.querySelector("[data-server-typed]");
  const cursor = terminal?.querySelector("[data-server-cursor]");
  const steps = terminal?.querySelectorAll(".deploy-step");
  const replay = terminal?.querySelector(".terminal-replay");
  if (!terminal || !typed || !cursor || !steps?.length) return;

  const command = "bun ship";
  let generation = 0;

  function run(delay = 0) {
    const current = ++generation;
    typed.textContent = "";
    cursor.classList.remove("done");
    replay?.classList.remove("is-ready");
    steps.forEach((step) => step.classList.remove("visible", "complete"));
    const rail = terminal.querySelector(".clack-rail");
    if (rail) rail.style.height = "0px";

    if (reducedMotion) {
      typed.textContent = command;
      cursor.classList.add("done");
      steps.forEach((step) => step.classList.add("visible", "complete"));
      railTo(terminal, steps[steps.length - 1]);
      return;
    }

    terminal.classList.add("is-animated");
    function reveal(index) {
      if (current !== generation || index >= steps.length) return;
      const row = steps[index];
      row.classList.add("visible");
      railTo(terminal, row);
      setTimeout(() => {
        if (current !== generation) return;
        row.classList.add("complete");
        if (index === steps.length - 1) replay?.classList.add("is-ready");
        else setTimeout(() => reveal(index + 1), 200);
      }, 300);
    }
    function type(index) {
      if (current !== generation) return;
      if (index < command.length) {
        typed.textContent += command[index];
        setTimeout(() => type(index + 1), typingDelay());
      } else {
        cursor.classList.add("done");
        setTimeout(() => reveal(0), 350);
      }
    }
    setTimeout(() => type(0), delay);
  }

  replay?.addEventListener("click", () => {
    replay.classList.remove("is-spinning");
    void replay.offsetWidth;
    replay.classList.add("is-spinning");
    run(80);
  });
  addEventListener("resize", () => {
    const visible = [...steps].filter((step) => step.classList.contains("visible"));
    if (visible.length) railTo(terminal, visible[visible.length - 1]);
  });
  run(600);
}

animateTerminal();

document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.dataset.theme = current === "dark" ? "light" : "dark";
  try { localStorage.setItem("shibumi-theme", root.dataset.theme); } catch {}
});

const stackMenus = [...document.querySelectorAll(".stack-menu")].filter((menu) => menu instanceof HTMLDetailsElement);
document.addEventListener("click", (event) => {
  for (const menu of stackMenus) if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const menu = stackMenus.find((candidate) => candidate.open);
  if (!menu) return;
  menu.open = false;
  menu.querySelector("summary")?.focus();
});

document.querySelector("[data-copy]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
    button.classList.add("is-copied");
    button.setAttribute("aria-label", "Install command copied");
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.setAttribute("aria-label", "Copy install command");
    }, 1_500);
  } catch {
    button.setAttribute("aria-label", "Could not copy install command");
  }
});
