(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const STORAGE_KEY = 'mbl-home-quiz-v1';
  const stepLabels = {
    furniture: 'Мебель',
    size: 'Размеры',
    budget: 'Бюджет',
    timeline: 'Срок',
  };
  const serviceMap = {
    kuhni: 'kuhni',
    shkafy: 'shkafy',
    garderobnye: 'garderobnye',
    other: 'other',
  };

  const initQuiz = (quiz) => {
    if (!(quiz instanceof HTMLElement) || quiz.dataset.quizInitialized === 'true') return;
    quiz.dataset.quizInitialized = 'true';

    const steps = Array.from(quiz.querySelectorAll('[data-quiz-step]'));
    const progress = quiz.querySelector('[data-quiz-progress]');
    const progressBar = quiz.querySelector('[data-quiz-progress-bar]');
    const progressLabel = quiz.querySelector('[data-quiz-progress-label]');
    const status = quiz.querySelector('[data-quiz-status]');
    const contactForm = quiz.querySelector('form.lead-contact-form');
    const messageInput = contactForm?.querySelector('textarea[name="message"]');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let currentStep = 0;
    let messageEdited = false;

    const readState = () => {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
        return parsed && parsed.version === 1 ? parsed : { version: 1, step: 0, answers: {} };
      } catch {
        return { version: 1, step: 0, answers: {} };
      }
    };

    const selectedAnswer = (key) => {
      const input = quiz.querySelector(`input[data-quiz-answer="${key}"]:checked`);
      if (!(input instanceof HTMLInputElement)) return null;
      return { 
        value: input.value,
        label: input.dataset.answerLabel || input.value,
      };
    };

    const getAnswers = () =>
      Object.keys(stepLabels).reduce((answers, key) => {
        const selected = selectedAnswer(key);
        if (selected) answers[key] = selected;
        return answers;
      }, {});

    const saveState = () => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 1, step: currentStep, answers: getAnswers() })
        );
      } catch {
        // Storage is an enhancement; the calculator remains usable without it.
      }
    };

    const syncLeadContext = () => {
      const answers = getAnswers();
      Object.keys(stepLabels).forEach((key) => {
        const output = quiz.querySelector(`[data-quiz-summary="${key}"]`);
        if (output instanceof HTMLElement) output.textContent = answers[key]?.label || 'Не выбрано';
      });

      const summary = Object.entries(stepLabels)
        .filter(([key]) => answers[key])
        .map(([key, label]) => `${label}: ${answers[key].label}`);
      if (!(contactForm instanceof HTMLFormElement)) return;

      const detail = {
        service: serviceMap[answers.furniture?.value] || 'unknown',
      };
      if (!messageEdited) detail.message = summary.length ? `Расчёт с главной:\n${summary.join('\n')}` : '';

      contactForm.dispatchEvent(new CustomEvent('mbl:lead-context-update', { detail }));
    };

    const showStep = (nextStep, options = {}) => {
      currentStep = Math.max(0, Math.min(steps.length - 1, nextStep));
      steps.forEach((step, index) => {
        const active = index === currentStep;
        step.toggleAttribute('hidden', !active);
        step.toggleAttribute('inert', !active);
        step.setAttribute('data-active', active ? 'true' : 'false');
      });

      const value = currentStep + 1;
      const label = `Шаг ${value} из ${steps.length}`;
      if (progress instanceof HTMLElement) {
        progress.setAttribute('aria-valuenow', String(value));
        progress.setAttribute('aria-valuetext', label);
      }
      if (progressBar instanceof HTMLElement) progressBar.style.width = `${(value / steps.length) * 100}%`;
      if (progressLabel instanceof HTMLElement) progressLabel.textContent = label;
      if (status instanceof HTMLElement) status.textContent = currentStep === 4 ? 'Перейдите к контактным данным.' : label;

      syncLeadContext();
      saveState();

      if (options.focus === true) {
        const target = steps[currentStep]?.querySelector('legend, [tabindex="-1"], input, button');
        if (target instanceof HTMLElement) {
          window.setTimeout(() => target.focus({ preventScroll: true }), reducedMotion ? 0 : 180);
        }
      }
    };

    const restore = () => {
      const state = readState();
      Object.entries(state.answers || {}).forEach(([key, answer]) => {
        const value = answer && typeof answer === 'object' ? answer.value : '';
        const input = quiz.querySelector(`input[data-quiz-answer="${key}"][value="${value}"]`);
        if (input instanceof HTMLInputElement) input.checked = true;
      });
      currentStep = Number.isInteger(state.step) ? Math.min(state.step, steps.length - 1) : 0;
      if (currentStep === steps.length - 1 && Object.keys(getAnswers()).length < 4) currentStep = 0;
    };

    quiz.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || !input.matches('[data-quiz-answer]')) return;
      input.closest('[data-quiz-step]')?.querySelector('[data-quiz-error]')?.setAttribute('hidden', '');
      syncLeadContext();
      saveState();
    });

    quiz.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const next = target.closest('[data-quiz-next]');
      if (next) {
        const step = steps[currentStep];
        const key = step?.getAttribute('data-step-key') || '';
        if (!selectedAnswer(key)) {
          const error = step?.querySelector('[data-quiz-error]');
          error?.removeAttribute('hidden');
          if (status instanceof HTMLElement) status.textContent = 'Выберите один вариант, чтобы продолжить.';
          step?.querySelector('input')?.focus();
          return;
        }
        showStep(currentStep + 1, { focus: true });
        return;
      }

      if (target.closest('[data-quiz-back]')) showStep(currentStep - 1, { focus: true });
    });

    if (messageInput instanceof HTMLTextAreaElement) {
      messageInput.addEventListener('input', (event) => {
        if (event.isTrusted) messageEdited = true;
      });
    }

    restore();
    quiz.dataset.enhanced = 'true';
    showStep(currentStep);
  };

  const init = () => document.querySelectorAll('[data-home-quiz]').forEach(initQuiz);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
  document.addEventListener('astro:after-swap', init);
})();
