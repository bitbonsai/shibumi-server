const frame = document.querySelector(".docs-frame");
if (frame) {
  const menu = frame.querySelector(".docs-menu");
  const sidebar = frame.querySelector(".docs-sidebar");
  const outline = frame.querySelector("[data-docs-outline]");
  const headings = [...frame.querySelectorAll(".docs-prose h2[id],.docs-prose h3[id]")];
  const setMenu = (open) => {
    frame.classList.toggle("docs-open", open);
    menu?.setAttribute("aria-expanded", String(open));
  };

  menu?.addEventListener("click", () => setMenu(true));
  frame.querySelector(".docs-close")?.addEventListener("click", () => setMenu(false));
  document.addEventListener("click", (event) => {
    if (frame.classList.contains("docs-open") && !event.target.closest(".docs-sidebar") && !event.target.closest(".docs-menu")) setMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && frame.classList.contains("docs-open")) {
      setMenu(false);
      menu?.focus();
    }
  });

  if (outline && headings.length) {
    for (const heading of headings) {
      const link = document.createElement("a");
      link.href = `#${heading.id}`;
      link.dataset.level = heading.tagName.slice(1);
      link.textContent = heading.firstChild?.textContent?.trim() || heading.textContent.trim();
      outline.append(link);
    }
    const links = [...outline.querySelectorAll("a")];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links) link.classList.toggle("active", link.hash === `#${entry.target.id}`);
      }
    }, { rootMargin: "-15% 0px -75%" });
    for (const heading of headings) observer.observe(heading);
  } else {
    frame.querySelector(".docs-outline")?.remove();
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-code]");
  if (!(button instanceof HTMLButtonElement)) return;
  const code = button.closest(".docs-code")?.querySelector("pre code")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(code.replace(/\n$/, ""));
    button.classList.add("is-copied");
    button.setAttribute("aria-label", "Code copied");
    setTimeout(() => {
      button.classList.remove("is-copied");
      button.setAttribute("aria-label", "Copy code");
    }, 1_500);
  } catch {
    button.setAttribute("aria-label", "Could not copy code");
  }
});
