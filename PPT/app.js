(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const current = document.querySelector('#current');
  const progress = document.querySelector('#progress');
  const previous = document.querySelector('#prev');
  const next = document.querySelector('#next');
  let index = 0;
  let touchStartX = 0;

  function showSlide(nextIndex) {
    index = Math.max(0, Math.min(slides.length - 1, nextIndex));
    slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === index);
      slide.setAttribute('aria-hidden', String(i !== index));
    });
    current.textContent = String(index + 1).padStart(2, '0');
    progress.style.width = `${((index + 1) / slides.length) * 100}%`;
    previous.disabled = index === 0;
    next.disabled = index === slides.length - 1;
    document.title = `${slides[index].dataset.title} · AI ChatBot`;
  }

  previous.addEventListener('click', () => showSlide(index - 1));
  next.addEventListener('click', () => showSlide(index + 1));
  document.querySelector('#print').addEventListener('click', () => window.print());
  document.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (['ArrowRight', 'PageDown', ' '].includes(event.key)) {
      event.preventDefault();
      showSlide(index + 1);
    } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      showSlide(index - 1);
    } else if (event.key.toLowerCase() === 'f') {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
    } else if (event.key.toLowerCase() === 'p') {
      window.print();
    } else if (event.key === 'Home') {
      showSlide(0);
    } else if (event.key === 'End') {
      showSlide(slides.length - 1);
    }
  });
  document.addEventListener('touchstart', event => { touchStartX = event.changedTouches[0].screenX; }, { passive: true });
  document.addEventListener('touchend', event => {
    const distance = event.changedTouches[0].screenX - touchStartX;
    if (Math.abs(distance) > 70) showSlide(index + (distance < 0 ? 1 : -1));
  }, { passive: true });

  showSlide(0);
})();
