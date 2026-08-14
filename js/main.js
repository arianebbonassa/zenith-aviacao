/*
  ============================================================================
  NOTA SOBRE O VÍDEO (assets/jet-v7-web.mp4)
  ============================================================================
  Para um scrub (busca de frame via scroll) perfeitamente fluido, o ideal é
  reencodar o vídeo com um keyframe interval curto — idealmente 1 GOP por
  frame (todo frame é keyframe), por exemplo com ffmpeg:

    ffmpeg -i jet-v7.mp4 -c:v libx264 -preset slow -crf 20 \
      -x264-params "keyint=1:min-keyint=1:scenecut=0" \
      -c:a aac -b:a 128k -movflags +faststart jet-v7-web.mp4

  Isso evita que o navegador precise decodificar vários frames P/B entre
  keyframes a cada seek, o que é a principal causa de "engasgos" no scrub.
  O arquivo assets/jet-v7-web.mp4 hoje é apenas uma cópia do original
  (assets/jet-v7.mp4) — ffmpeg não está disponível neste ambiente. Reencode-o
  com o comando acima assim que possível para o scrub ficar mais suave.
  ============================================================================
*/

(function () {
  "use strict";

  const video = document.getElementById("jetVideo");
  const scrollTrack = document.getElementById("scrollTrack");
  const pinStage = document.getElementById("pinStage");
  const heroCopy = document.getElementById("heroCopy");
  const scrollIndicator = document.getElementById("scrollIndicator");
  const section1Copy = document.getElementById("section1Copy");
  const section2Copy = document.getElementById("section2Copy");
  const section3Copy = document.getElementById("section3Copy");
  const featureCards = Array.from(document.querySelectorAll("#featureCards .floating-card"));
  const destinationCards = Array.from(document.querySelectorAll("#destinationCards .floating-card"));

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isSmallScreen = window.matchMedia("(max-width: 768px)").matches;
  const connection = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
  const isSlowConnection = !!(
    connection &&
    (connection.saveData === true || /2g/.test(connection.effectiveType || ""))
  );

  const useFallback = isSmallScreen || isSlowConnection;

  /*
    ==========================================================================
    TIMING — mapa de "quando cada coisa acontece" ao longo do scroll
    ==========================================================================
    Todos os valores são frações de 0 a 1 do progresso total do scroll-track
    (0 = topo da página, 1 = fim do scroll-track). Isso é independente da
    altura em vh definida em css/style.css (.scroll-track) — se você mudar
    essa altura, a pacing relativa entre as seções continua a mesma, só
    muda a "lentidão" física do scroll.

    [inicio, fim] de cada "enter"/"exit" é a janela de transição (fade +
    blur + translateY). Fora dessa janela o elemento fica 100% visível
    (entre enter[1] e exit[0]) ou 100% invisível.

    AJUSTE AQUI para mudar o ritmo da narrativa:
      - Adiar quando o Hero desaparece: aumentar heroFade[1]
      - Fazer a Seção 1 durar mais na tela: afastar section1.enter[1] de section1.exit[0]
      - Adiar a chegada ao "interior": aumentar section2.enter[0]
      - Deixar os cards aparecerem mais espaçados entre si: aumentar cardStagger.step
      - Fazer o "Destino" (Seção 3) ficar mais tempo antes de sumir: afastar
        section3.exit[0] de section3.enter[1] (hoje ele segura bem até perto
        do fim do vídeo, para o corte para a Seção 4/CTA ficar suave)
  */
  const TIMING = {
    heroFade: [0, 0.06], // hero (H1/subtítulo) desaparece nesta janela
    indicatorHideAt: 0.02, // "Role para explorar" some assim que o scroll começa

    section1: {
      enter: [0.1, 0.16], // "Mais do que um voo." entra
      exit: [0.22, 0.27], // ...e sai, dando lugar à aproximação da aeronave
    },

    section2: {
      enter: [0.32, 0.38], // "Luxo em cada detalhe." entra (já "dentro" do avião)
      exit: [0.5, 0.56], // seção do interior se despede
    },

    // Cada card entra em sua própria janela, defasada (stagger) a partir
    // do início visível da Seção 2. `span` é a duração do fade de cada
    // card; `step` é o intervalo entre o início de um card e o próximo.
    //
    // INVARIANTE (bug já visto uma vez, não reintroduzir): o enter do
    // ÚLTIMO card — start + (n-1)*step + span — precisa terminar ANTES de
    // section2.exit[0], com folga. Se ele "vazar" para dentro da janela de
    // exit, esse card nunca chega a opacity:1/blur:0 (o fade-in ainda está
    // em andamento quando o fade-out já começou), e ele fica permanentemente
    // esmaecido/borrado — foi exatamente o que aconteceu com o 3º card
    // (Gastronomia de Altitude) quando o step/span empurravam seu enter
    // para 0.47–0.52, invadindo o exit em 0.5.
    cardStagger: {
      start: 0.38,
      span: 0.04,
      step: 0.025,
      // 3 cards ⇒ último enter termina em 0.38 + 2*0.025 + 0.04 = 0.47,
      // ou seja, 0.03 de folga antes de section2.exit[0] (0.5).
    },

    section3: {
      enter: [0.62, 0.68], // "O mundo ao seu alcance." entra
      exit: [0.94, 0.99], // segura quase até o fim do vídeo, depois some
    },

    // Mesma lógica do cardStagger, para os cards de destino da Seção 3.
    destinationCardStagger: {
      start: 0.7,
      span: 0.05,
      step: 0.035,
    },
  };

  // Quão "pesado" é o amortecimento (lerp) do vídeo: quanto menor, mais
  // suave/lento o currentTime persegue o scroll; quanto maior, mais direto
  // (mais responsivo, porém mais próximo de setar o valor cru do scroll).
  const SCRUB_SMOOTHING = 0.12;

  if (useFallback) {
    initFallback();
  } else {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      initScrub();
    };

    if (video.readyState >= 1) {
      start();
    } else {
      video.addEventListener("loadedmetadata", start, { once: true });
    }

    // Se o vídeo falhar ao carregar (rede, etc.), degrada com elegância.
    video.addEventListener(
      "error",
      () => {
        if (!started) {
          started = true;
          initFallback();
        }
      },
      { once: true }
    );

    // Rede de segurança caso "loadedmetadata" nunca dispare.
    window.setTimeout(() => {
      if (!started) {
        started = true;
        initFallback();
      }
    }, 4000);
  }

  // Independentes do pin do vídeo — rodam sempre, tanto no modo cinematográfico
  // quanto no fallback mobile/conexão lenta, pois a Seção 4 é conteúdo normal
  // de página (não faz parte do scroll-track).
  initScrollReveals();
  initContactForm();

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  function mapRange(value, inMin, inMax, outMin, outMax) {
    const t = clamp01((value - inMin) / (inMax - inMin));
    return outMin + t * (outMax - outMin);
  }

  // Opacity/y/blur de um elemento que entra e depois sai dentro de uma
  // janela [enter, exit] de progresso — usado pelas duas seções de texto.
  function enterExitStyle(p, enter, exit, distance, blurPx) {
    const enterP = mapRange(p, enter[0], enter[1], 0, 1);
    const exitP = mapRange(p, exit[0], exit[1], 0, 1);
    return {
      opacity: enterP * (1 - exitP),
      y: distance * (1 - enterP) - distance * exitP,
      blur: blurPx * (1 - enterP) + blurPx * exitP,
    };
  }

  /**
   * Experiência estática / baixo consumo: sem pin, sem scrub de vídeo.
   * Usa poster.jpg como âncora visual; conteúdo revela ao entrar na tela.
   */
  function initFallback() {
    pinStage.classList.add("is-static");
    scrollTrack.style.height = "auto";
    pinStage.style.height = "100vh";

    heroCopy.classList.add("visible");
    scrollIndicator.classList.add("visible");

    [section1Copy, section2Copy, section3Copy].forEach((section) => {
      section.style.position = "relative";
      section.style.left = "auto";
      section.style.top = "auto";
      section.style.bottom = "auto";
      section.style.transform = "translateY(24px)";
      section.style.margin = "0 auto";
      section.style.padding = "6rem 1.5rem";
      section.style.transition = "opacity 0.9s ease, transform 0.9s ease";
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            entry.target.style.transform = "translateY(0)";
          }
        });
      },
      { threshold: 0.35 }
    );
    observer.observe(section1Copy);
    observer.observe(section2Copy);
    observer.observe(section3Copy);

    let hidden = false;
    window.addEventListener(
      "scroll",
      () => {
        if (!hidden && window.scrollY > 40) {
          hidden = true;
          scrollIndicator.classList.add("hidden");
        } else if (hidden && window.scrollY <= 40) {
          hidden = false;
          scrollIndicator.classList.remove("hidden");
        }
      },
      { passive: true }
    );
  }

  /**
   * Experiência cinematográfica completa: a posição do scroll controla o
   * currentTime do vídeo (amortecido via lerp) e a coreografia dos textos.
   */
  function initScrub() {
    gsap.registerPlugin(ScrollTrigger);

    const duration = video.duration || 1;
    let targetTime = 0;
    let renderedTime = -1;
    let rafId = null;

    ScrollTrigger.create({
      trigger: scrollTrack,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      pin: pinStage,
      pinSpacing: false,
      onUpdate: (self) => {
        const p = self.progress;

        // MAPEAMENTO SCROLL -> FRAME DO VÍDEO
        // p (0 a 1) é multiplicado pela duração total do vídeo. É aqui que
        // "scroll para baixo avança o vídeo, scroll para cima retrocede".
        targetTime = p * duration;

        // Indicador de scroll some assim que o usuário começa a interagir.
        if (p > TIMING.indicatorHideAt) {
          scrollIndicator.classList.add("hidden");
        } else {
          scrollIndicator.classList.remove("hidden");
        }

        // Hero (H1 + subtítulo): fade + leve subida + blur logo no início.
        const heroP = mapRange(p, TIMING.heroFade[0], TIMING.heroFade[1], 0, 1);
        gsap.set(heroCopy, {
          opacity: 1 - heroP,
          y: -40 * heroP,
          filter: `blur(${6 * heroP}px)`,
        });

        // Seção 1 — "Mais do que um voo."
        const s1 = enterExitStyle(p, TIMING.section1.enter, TIMING.section1.exit, 40, 10);
        gsap.set(section1Copy, {
          opacity: s1.opacity,
          y: s1.y,
          filter: `blur(${s1.blur}px)`,
        });

        // Seção 2 — "Luxo em cada detalhe." (interior / a bordo)
        const s2 = enterExitStyle(p, TIMING.section2.enter, TIMING.section2.exit, 40, 10);
        gsap.set(section2Copy, {
          opacity: s2.opacity,
          y: s2.y,
          filter: `blur(${s2.blur}px)`,
        });

        // Cards flutuantes da Seção 2: cada um entra com um pequeno atraso
        // (stagger) em relação ao anterior, saindo junto com a Seção 2.
        //
        // Trava de segurança: o exit de cada card nunca começa antes do seu
        // próprio enter terminar (Math.max abaixo). Isso garante que todo
        // card sempre passe por um instante de opacity:1/blur:0 antes de
        // começar a sumir, mesmo que o TIMING.cardStagger seja reajustado
        // no futuro e volte a "vazar" para dentro da janela de exit — sem
        // essa trava, o card fica preso num meio-termo borrado/esmaecido
        // (foi o bug do 3º card, "Gastronomia de Altitude").
        featureCards.forEach((card, i) => {
          const enterStart = TIMING.cardStagger.start + i * TIMING.cardStagger.step;
          const enterEnd = enterStart + TIMING.cardStagger.span;
          const exitStart = Math.max(TIMING.section2.exit[0], enterEnd);
          const card_ = enterExitStyle(
            p,
            [enterStart, enterEnd],
            [exitStart, TIMING.section2.exit[1]],
            28,
            8
          );
          gsap.set(card, {
            opacity: card_.opacity,
            y: card_.y,
            filter: `blur(${card_.blur}px)`,
          });
        });

        // Seção 3 — "O mundo ao seu alcance." (destino / além das fronteiras)
        const s3 = enterExitStyle(p, TIMING.section3.enter, TIMING.section3.exit, 40, 10);
        gsap.set(section3Copy, {
          opacity: s3.opacity,
          y: s3.y,
          filter: `blur(${s3.blur}px)`,
        });

        // Cards de destino da Seção 3, mesmo esquema de stagger — mesma
        // trava de segurança (exitStart nunca antes do enter terminar).
        destinationCards.forEach((card, i) => {
          const enterStart = TIMING.destinationCardStagger.start + i * TIMING.destinationCardStagger.step;
          const enterEnd = enterStart + TIMING.destinationCardStagger.span;
          const exitStart = Math.max(TIMING.section3.exit[0], enterEnd);
          const card_ = enterExitStyle(
            p,
            [enterStart, enterEnd],
            [exitStart, TIMING.section3.exit[1]],
            28,
            8
          );
          gsap.set(card, {
            opacity: card_.opacity,
            y: card_.y,
            filter: `blur(${card_.blur}px)`,
          });
        });
      },
    });

    // Loop rAF: amortece (lerp) o currentTime em direção ao alvo derivado
    // do scroll, em vez de setar o valor cru — evita seeks bruscos/travados.
    function tick() {
      const delta = targetTime - renderedTime;

      if (reduceMotion) {
        renderedTime = targetTime;
      } else if (Math.abs(delta) < 0.004) {
        renderedTime = targetTime;
      } else {
        renderedTime += delta * SCRUB_SMOOTHING;
      }

      if (Math.abs(video.currentTime - renderedTime) > 0.004) {
        try {
          video.currentTime = renderedTime;
        } catch (e) {
          /* seek pode falhar se os metadados ainda não estiverem prontos */
        }
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);

    window.addEventListener("beforeunload", () => {
      if (rafId) cancelAnimationFrame(rafId);
    });
  }

  /**
   * Seção 4 (CTA/Contato) e rodapé: fade-up simples ao entrar na tela.
   * Isto NÃO é scrub — é um reveal comum de "on enter viewport", separado
   * do pin do vídeo, usando o mesmo GSAP + ScrollTrigger já carregado.
   * Roda em ambos os modos (cinematográfico e fallback).
   */
  function initScrollReveals() {
    // .reveal-up começa com opacity:0 via CSS (ver style.css). Se o GSAP/
    // ScrollTrigger não carregar por algum motivo (CDN bloqueado, etc.),
    // é essencial revelar o conteúdo mesmo assim — nunca deixar a Seção 4
    // permanentemente invisível por falta de JS de animação.
    if (typeof gsap === "undefined" || typeof ScrollTrigger === "undefined") {
      document.querySelectorAll(".reveal-up").forEach((el) => {
        el.style.opacity = "1";
      });
      return;
    }

    gsap.registerPlugin(ScrollTrigger);

    const elements = gsap.utils.toArray(".reveal-up");

    if (reduceMotion) {
      // Sem movimento: mostra tudo de imediato, sem animação de entrada.
      elements.forEach((el) => gsap.set(el, { opacity: 1 }));
      return;
    }

    elements.forEach((el) => {
      gsap.fromTo(
        el,
        { opacity: 0, y: 32 },
        {
          opacity: 1,
          y: 0,
          duration: 0.9,
          ease: "power2.out",
          scrollTrigger: {
            trigger: el,
            start: "top 85%",
            toggleActions: "play none none reverse",
          },
        }
      );
    });
  }

  /**
   * Formulário de contato da Seção 4. Hoje só valida e mostra feedback
   * local — NÃO envia dados a lugar nenhum ainda.
   *
   * TODO antes de publicar: substituir o handler abaixo por uma chamada
   * real (fetch para uma API própria, Formspree, HubSpot, etc.) que
   * efetivamente entregue os dados à equipe de concierge.
   */
  function initContactForm() {
    const form = document.getElementById("contactForm");
    const feedback = document.getElementById("formFeedback");
    if (!form || !feedback) return;

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      feedback.textContent =
        "Recebemos suas informações — nossa equipe de concierge entrará em contato em breve.";
      form.reset();
    });
  }
})();
