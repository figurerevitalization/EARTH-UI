import { Application } from 'https://unpkg.com/@splinetool/runtime@1.9.5/build/runtime.js';

/**
 * Cinematic Portfolio - Core Rendering Engine
 * Hardware-accelerated, lerp-smoothed, memory-managed.
 */

class CinematicEngine {
    constructor() {
        this.cache = new Map(); // Store ImageBitmaps
        this.frames = [];
        this.totalFrames = 0;
        this.fallbackMode = true;
        this.canvas = document.getElementById('sequence-canvas');
        this.ctx = this.canvas.getContext('2d', { alpha: false }); // alpha: false for performance
        this.targetProgress = 0;
        this.currentProgress = 0;
        this.rafId = null;
        this.loadedCount = 0;

        // Loading overlay DOM
        this.loadingOverlay = document.getElementById('loadingOverlay');
        this.loadingBar = document.getElementById('loadingBar');
        this.loadingPercent = document.getElementById('loadingPercent');
        this.displayedPercent = 0; // For animated counter
        this.percentAnimationFrameId = null;

        // Settings
        this.batchSize = 15; // Smaller batch for 99 frames

        // For 99 frames: increase pixels per frame so each frame has more scroll space
        const isMobile = window.innerWidth < 768; // Detect mobile early for sensitivity
        this.pixelsPerFrame = isMobile ? 65 : 36; // Much larger scroll distance per frame on mobile reduces lag

        // Procedural fallbacks variables
        this.geometryRotation = 0;

        // When true, freeze progress at the very end (hold last frame)
        this.holdLastFrame = false;

        // Overlay DOM
        this.overlays = Array.from(document.querySelectorAll('.story-beat'));
        this.navbar = document.querySelector('.navbar');

        // Debug overlay to show progress/frame values (helps diagnose transitions)
        this.debugOverlay = null;

        this.init();
    }

    async init() {
        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Telemetry DOM
        this.domFrame = document.getElementById('debug-frame');
        this.domTarget = document.getElementById('debug-target');
        this.domStatus = document.getElementById('debug-status');
        this.domBar = document.getElementById('debug-bar');
        this.domVelocity = document.getElementById('debug-velocity');
        this.domBuffer = document.getElementById('debug-buffer');
        this.domFps = document.getElementById('debug-fps');

        // Telemetry state
        this.fpsLastTime = performance.now();
        this.fpsFrames = 0;
        this.currentFps = 60;

        // Determine environment
        const isMobile = window.innerWidth < 768 || window.devicePixelRatio > 2 && window.navigator.deviceMemory < 4;
        const variant = isMobile ? 'mobile' : 'desktop';

        try {
            // Fetch manifest from Node API
            const response = await fetch(`/api/frames?variant=${variant}`);
            const data = await response.json();

            if (data.frames && data.frames.length > 0) {
                this.frames = data.frames;
                this.totalFrames = data.totalFrames;
                this.batchSize = Math.max(20, data.batchSize || 30); // Aggressive preload
                this.fallbackMode = false;

                // Ensure scroll-container height maps to frames so each frame is
                // reachable by scrolling. This avoids the scroll feeling "cut"
                // and makes viewing a full ~240-frame sequence comfortable.
                try {
                    const container = document.querySelector('.scroll-container');
                    const pixelsPerFrame = this.pixelsPerFrame || 6;
                    const targetHeight = Math.max((this.totalFrames * pixelsPerFrame) + window.innerHeight, window.innerHeight * 3);
                    container.style.height = `${targetHeight}px`;
                } catch (e) {
                    // ignore if DOM unavailable
                }

                // Aggressive true preloading: Force the engine to hold the loading
                // overlay until every single frame is fetched and decoded.

                const batchPromises = [];
                // Load all frames in parallel chunks to avoid blowing up the network tab simultaneously
                const parallelLimit = 20;
                for (let i = 0; i < this.totalFrames; i += parallelLimit) {
                    batchPromises.push(this.preloadBatch(i, parallelLimit));
                }

                // Wait for the absolute entire asset sequence to load
                await Promise.all(batchPromises);

                // Display the first frame by default
                this.currentProgress = 0;
                this.targetProgress = 0;
                this.renderFrame(0);

                // Now that everything is 100% physically loaded, allow the overlay to drop
                this.finishLoading();

            } else {
                this.fallbackMode = true;
                this.totalFrames = 120; // simulate frames for procedural
                this.renderFrame(0); // Render procedural frame 0
                this.finishLoading();
            }
        } catch (e) {
            console.warn('API not available, falling back to procedural geometric rendering and static behavior.');
            this.fallbackMode = true;
            this.totalFrames = 120;
            this.renderFrame(0);
            this.finishLoading();
        }

        this.bindScroll();
        this.bindControls();
        this.startLoop();
        // preloadRestIdle is no longer strictly necessary if doing 100% preload, 
        // but left safely active as a fallback.
        this.preloadRestIdle();
    }

    finishLoading() {
        if (this.loadingOverlay) {
            setTimeout(() => {
                this.loadingOverlay.classList.add('hidden');
            }, 600); // Slight delay for the 100% animation to breathe
        }
    }

    resize() {
        // High DPI canvas
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);

        // If we are holding an image, re-render immediately
        this.renderFrame(this.getCurrentFrameIndex());
    }

    updateLoadingProgress() {
        if (!this.frames.length) return;

        const loadingPercent = Math.round((this.loadedCount / this.totalFrames) * 100);
        const barPercent = Math.min(loadingPercent, 100); // Allow it to reach 100

        // Update bar width
        if (this.loadingBar) {
            this.loadingBar.style.width = `${barPercent}%`;
        }

        // Animate percentage counter
        this.animatePercentCounter(loadingPercent);
    }

    animatePercentCounter(targetPercent) {
        if (!this.loadingPercent) return;

        // Cancel any ongoing animation
        if (this.percentAnimationFrameId) {
            cancelAnimationFrame(this.percentAnimationFrameId);
        }

        // Animate from current to target
        const animateCounter = () => {
            if (this.displayedPercent < targetPercent) {
                this.displayedPercent = Math.min(this.displayedPercent + 3, targetPercent);
                this.loadingPercent.textContent = `${this.displayedPercent}`;
                this.percentAnimationFrameId = requestAnimationFrame(animateCounter);
            } else if (this.displayedPercent > targetPercent) {
                this.displayedPercent = targetPercent;
                this.loadingPercent.textContent = `${this.displayedPercent}`;
            }
        };

        animateCounter();
    }

    async preloadBatch(startIndex, count) {
        const endIndex = Math.min(startIndex + count, this.frames.length);
        const promises = [];

        for (let i = startIndex; i < endIndex; i++) {
            if (!this.cache.has(i)) {
                promises.push(this.loadImage(i));
            }
        }
        await Promise.all(promises);
    }

    async loadImage(index) {
        const path = this.frames[index];
        try {
            const response = await fetch(path);
            const blob = await response.blob();
            // Decode off main thread using ImageBitmap
            const bitmap = await createImageBitmap(blob);
            this.cache.set(index, bitmap);
            this.loadedCount++;

            // Update loading bar progress
            this.updateLoadingProgress();

            // Force re-render immediately if this was the frame we are actively waiting for
            if (index === this.getCurrentFrameIndex()) {
                this.renderFrame(index);
            }

            // Memory Management: Elite Level
            // Keep current ±20 frames, discard others if memory is a concern
            this.manageMemory(index);
        } catch (e) {
            console.error('Failed to load frame', index, e);
        }
    }

    manageMemory(currentIndex) {
        // Expand cache size massively to prevent frame drops
        const maxCache = 150; // Increased buffer
        const evictionDistance = 80;
        if (this.cache.size > maxCache) {
            for (let [key, val] of this.cache.entries()) {
                // NEVER evict the first frame so it's instantly ready when scrolling to top
                if (key === 0) continue;

                if (Math.abs(key - currentIndex) > evictionDistance) {
                    try { val.close(); } catch (e) { }
                    this.cache.delete(key);
                }
            }
        }
    }

    // Use prioritize preloading near the current frame to prevent lag
    preloadRestIdle() {
        if (this.fallbackMode) return;

        const loadNext = () => {
            const currentIndex = this.getCurrentFrameIndex();
            let nextIndex = -1;

            // Load frames closest to current index first, prioritizing forward scroll
            // Search all the way to totalFrames instead of just 20 to ensure 
            // the idle loader doesn't give up early.
            for (let offset = 0; offset <= this.totalFrames; offset++) {
                let forward = currentIndex + offset;
                if (forward < this.totalFrames && !this.cache.has(forward)) {
                    nextIndex = forward;
                    break;
                }
                let backward = currentIndex - offset;
                if (backward >= 0 && !this.cache.has(backward)) {
                    nextIndex = backward;
                    break;
                }
            }

            if (nextIndex !== -1) {
                this.loadImage(nextIndex).finally(() => {
                    if ('requestIdleCallback' in window) {
                        requestIdleCallback(loadNext);
                    } else {
                        setTimeout(loadNext, 16);
                    }
                });
            } else {
                // Nothing to load nearby right now, check again in a bit
                setTimeout(loadNext, 100);
            }
        };

        if ('requestIdleCallback' in window) {
            requestIdleCallback(loadNext);
        } else {
            setTimeout(loadNext, 50);
        }
    }

    bindScroll() {
        const container = document.querySelector('.scroll-container');
        window.addEventListener('scroll', () => {
            const rect = container.getBoundingClientRect();
            // maxScroll defines the exact distance from the container top to the point
            // where the user has scrolled fully to the bottom of the container.
            const documentScrollTop = window.scrollY;
            const containerOffsetTop = documentScrollTop + rect.top;

            const maxScroll = rect.height - window.innerHeight;

            let rawProgress = (documentScrollTop - containerOffsetTop) / maxScroll;

            // Clamp strictly between 0 and 1
            // 1.0 progress is reached exactly when the user hits the absolute bottom of the scroll container.
            let p = Math.max(0, Math.min(1, rawProgress));

            // Keep targetProgress at 0 by default until user scrolls
            // This ensures frame 0 stays visible on page load
            if (p === 0) {
                this.targetProgress = 0;
                this.holdLastFrame = false;
            } else if (p >= 1) {
                this.targetProgress = 1;
                this.holdLastFrame = true;
            } else {
                this.targetProgress = p;
                this.holdLastFrame = false;
            }

            // Navbar logic
            if (window.scrollY > 50) {
                this.navbar.classList.add('scrolled');
            } else {
                this.navbar.classList.remove('scrolled');
            }
        }, { passive: true });
    }

    bindControls() {
        const upBtn = document.querySelector('.scroll-up');
        const downBtn = document.querySelector('.scroll-down');

        let scrollInterval = null;
        let isHolding = false;

        // Speed of continuous scroll (pixels per frame)
        const speed = this.pixelsPerFrame * 0.6;

        const startScroll = (direction) => {
            if (isHolding) return;
            isHolding = true;

            const step = () => {
                if (!isHolding) return;
                window.scrollBy({ top: direction * speed, behavior: 'auto' });
                scrollInterval = requestAnimationFrame(step);
            };
            scrollInterval = requestAnimationFrame(step);
        };

        const stopScroll = () => {
            isHolding = false;
            if (scrollInterval) cancelAnimationFrame(scrollInterval);
        };

        const bindHoldEvents = (btn, direction) => {
            if (!btn) return;
            // Mouse events
            btn.addEventListener('mousedown', () => startScroll(direction));
            btn.addEventListener('mouseup', stopScroll);
            btn.addEventListener('mouseleave', stopScroll);

            // Touch events
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault(); // prevent unwanted screen dragging/zooming
                startScroll(direction);
            }, { passive: false });
            btn.addEventListener('touchend', stopScroll);
            btn.addEventListener('touchcancel', stopScroll);
        };

        bindHoldEvents(upBtn, -1);
        bindHoldEvents(downBtn, 1);
    }

    easeInOutCubic(x) {
        // Linear is actually better for image sequences of this length so every frame is seen
        return x;
    }

    getCurrentFrameIndex() {
        const eased = this.easeInOutCubic(this.currentProgress);
        // Use floor so frames are held continuously until the progress crosses
        // the next frame threshold. This helps guarantee every frame is visible
        // during a full scroll across the container.
        let mappedIndex = Math.min(this.totalFrames - 1, Math.floor(eased * this.totalFrames));
        return Math.max(0, Math.min(this.totalFrames - 1, mappedIndex));
    }

    startLoop() {
        let lastFrameIndex = -1;

        const loop = () => {
            // FPS Calculation
            const now = performance.now();
            this.fpsFrames++;
            if (now - this.fpsLastTime >= 1000) {
                this.currentFps = this.fpsFrames;
                this.fpsFrames = 0;
                this.fpsLastTime = now;
            }

            // Lerp - Buttery smooth cinematic momentum
            // Lower lerp factor (0.07) introduces heavy inertia, eliminating trackpad stutter.
            let lerpFactor = this.targetProgress > 0.95 ? 0.04 : 0.07;
            this.currentProgress += (this.targetProgress - this.currentProgress) * lerpFactor;

            // Precision snapping to prevent endless floating point calculations
            if (Math.abs(this.targetProgress - this.currentProgress) < 0.0001) {
                this.currentProgress = this.targetProgress;
            }

            // Subtle cinematic scale just after the text ends (after 0.95 progress)
            // to give a "premium" visual completion.
            const canvasScale = 1 + Math.max(0, (this.currentProgress - 0.95) * 0.8);
            this.canvas.style.transform = `scale(${canvasScale})`;

            const frameIndex = this.getCurrentFrameIndex();

            // Render Frame only when the integer changes, preventing redundant canvas draws
            if (frameIndex !== lastFrameIndex) {
                this.renderFrame(frameIndex);
                lastFrameIndex = frameIndex;
            } else {
                // Keep updating telemetry even if frame doesn't change (e.g., velocity updates)
                this.updateTelemetry(frameIndex);
            }

            // Render Overlays continuously for sub-pixel smooth opacity/translate
            this.updateOverlays(this.currentProgress);

            this.rafId = requestAnimationFrame(loop);
        };
        loop();
    }

    renderFrame(index) {
        const width = this.canvas.getBoundingClientRect().width;
        const height = this.canvas.getBoundingClientRect().height;

        if (this.fallbackMode) {
            this.ctx.fillStyle = '#000000'; // Pure black for seamless integration
            this.ctx.fillRect(0, 0, width, height);
            this.renderProcedural(index, width, height);
            return;
        }

        let bitmap = this.cache.get(index);

        // Anti-Frame Drop Logic: Fallback to the closest available loaded frame 
        // to prevent black flashing when scrolling fast
        if (!bitmap) {
            const maxSearch = 30; // Check vigorously for closest frames
            for (let offset = 1; offset <= maxSearch; offset++) {
                if (this.cache.has(index - offset)) {
                    bitmap = this.cache.get(index - offset);
                    break;
                }
                if (this.cache.has(index + offset)) {
                    bitmap = this.cache.get(index + offset);
                    break;
                }
            }
        }

        if (bitmap) {
            // Only clear the canvas when we ACTUALLY have a frame to draw
            this.ctx.fillStyle = '#000000';
            this.ctx.fillRect(0, 0, width, height);

            // Let's use object-fit COVER logic so the image fills the screen without squishing or leaving edges
            const hRatio = width / bitmap.width;
            const vRatio = height / bitmap.height;
            const ratio = Math.max(hRatio, vRatio); // Use Max to COVER the screen entirely

            const newWidth = bitmap.width * ratio;
            const newHeight = bitmap.height * ratio;

            const centerShift_x = (width - newWidth) / 2;
            const centerShift_y = (height - newHeight) / 2;

            this.ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height,
                centerShift_x, centerShift_y, newWidth, newHeight);
        }

        // Update Telemetry UI
        this.updateTelemetry(index);
    }

    updateTelemetry(index) {
        if (!this.domFrame) return;

        // Frame ID (pad with zeros)
        this.domFrame.textContent = index.toString().padStart(3, '0');

        // Target Delta
        this.domTarget.textContent = this.targetProgress.toFixed(3);

        // Status checks
        if (this.fallbackMode) {
            this.domStatus.textContent = "PROCEDURAL";
            this.domStatus.className = "value status-warn";
        } else if (!this.cache.has(index)) {
            this.domStatus.textContent = "DROPPED";
            this.domStatus.className = "value status-error";
        } else {
            this.domStatus.textContent = "SYNCED";
            this.domStatus.className = "value status-good";
        }

        // Velocity Tracking
        if (this.domVelocity) {
            const velocity = Math.abs(this.targetProgress - this.currentProgress) * 100;
            this.domVelocity.textContent = velocity.toFixed(3);
        }

        // Cache Buffer State
        if (this.domBuffer) {
            this.domBuffer.textContent = `${this.cache.size} / ${this.totalFrames}`;
        }

        // FPS Tracker
        if (this.domFps) {
            this.domFps.textContent = this.currentFps.toString().padStart(2, '0');
            if (this.currentFps < 30) {
                this.domFps.className = "value status-error";
            } else if (this.currentFps < 50) {
                this.domFps.className = "value status-warn";
            } else {
                this.domFps.className = "value status-good hardware-accel";
            }
        }

        // Graph Bar width
        const percentage = Math.round(this.targetProgress * 100);
        if (this.domBar) {
            this.domBar.style.width = `${percentage}%`;
        }
    }

    renderProcedural(index, w, h) {
        // Procedural rendering disabled - using solid black
        // This prevents the circular/geometric fallback graphics from appearing
        return;
    }

    updateOverlays(progress) {
        this.overlays.forEach((overlay, index) => {
            const start = parseFloat(overlay.dataset.start);
            const end = parseFloat(overlay.dataset.end);

            // Localized progress [0, 1] for this specific segment
            // We want it to fade in at start, stay for a bit, fade out near end
            const duration = end - start;
            let localProgress = (progress - start) / duration;

            if (localProgress < 0 || localProgress > 1) {
                overlay.style.opacity = 0;
                // Don't translate the very first frame off-screen backwards, keep it locked
                const ty = index === 0 ? 0 : 40;
                overlay.style.transform = `translateY(${ty}px)`;
                overlay.style.filter = `blur(10px)`;
                overlay.style.visibility = 'hidden';
            } else {
                // Bell curve for opacity (fade in then out)
                let opacity = 1;
                // Fade in quickly (first 20% of section duration)
                if (localProgress < 0.2) opacity = localProgress / 0.2;
                // Fade out quickly (last 20% of section duration)
                if (localProgress > 0.8) opacity = (1 - localProgress) / 0.2;

                // Translate moves slowly upward as scroll continues
                // BUT for the 0th frame, freeze its Y axis! We want it sticky while scrolling
                const ty = index === 0 ? 0 : 40 - (localProgress * 80);

                // Blur effect on entry/exit
                const blur = (1 - opacity) * 8;

                overlay.style.opacity = Math.max(0, opacity);
                overlay.style.transform = `translateY(${ty}px)`;
                overlay.style.filter = `blur(${Math.max(0, blur)}px)`;
                overlay.style.visibility = opacity > 0 ? 'visible' : 'hidden';
            }
        });
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    window.cinematicEngine = new CinematicEngine();

    // Telemetry Terminal Drag Logic
    const terminal = document.getElementById('telemetryTerminal');
    const header = document.getElementById('terminalHeader');
    const toggleBtn = document.querySelector('.terminal-toggle');
    const body = document.querySelector('.terminal-body');

    let isDragging = false;
    let startX, startY;
    let initialX, initialY;
    let currentX = 0, currentY = 0;

    // Check if terminal is minimized
    let isMinimized = false;

    if (terminal && header) {
        header.addEventListener('mousedown', dragStart);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);

        // Touch support
        header.addEventListener('touchstart', dragStart, { passive: true });
        document.addEventListener('touchmove', drag, { passive: false });
        document.addEventListener('touchend', dragEnd);
    }

    if (toggleBtn && body) {
        toggleBtn.addEventListener('click', () => {
            isMinimized = !isMinimized;
            body.style.display = isMinimized ? 'none' : 'block';
            toggleBtn.textContent = isMinimized ? '+' : '_';
        });
    }

    // ---------------------------------------------------------
    // Mobile Hamburger Menu Logic
    // ---------------------------------------------------------
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenuOverlay = document.getElementById('mobileMenuOverlay');
    const mobileMenuCloseBtn = document.getElementById('mobileMenuCloseBtn');
    const mobileNavLinks = document.querySelectorAll('.mobile-nav-links a');

    if (mobileMenuBtn && mobileMenuOverlay) {
        mobileMenuBtn.addEventListener('click', () => {
            mobileMenuBtn.classList.add('active');
            mobileMenuOverlay.classList.add('active');
        });

        // Close menu function
        const closeMobileMenu = () => {
            mobileMenuBtn.classList.remove('active');
            mobileMenuOverlay.classList.remove('active');
        };

        // Close via dedicated X button
        if (mobileMenuCloseBtn) {
            mobileMenuCloseBtn.addEventListener('click', closeMobileMenu);
        }

        // Close menu when a link is clicked
        mobileNavLinks.forEach(link => {
            link.addEventListener('click', closeMobileMenu);
        });
    }

    function dragStart(e) {
        if (e.target === toggleBtn) return;

        if (e.type === 'touchstart') {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        } else {
            startX = e.clientX;
            startY = e.clientY;
        }

        const rect = terminal.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        // Reset right/bottom positioning to work with transforms smoothly
        terminal.style.left = `${initialX}px`;
        terminal.style.top = `${initialY}px`;
        terminal.style.right = 'auto';
        terminal.style.bottom = 'auto';
        terminal.style.transform = `translate(0px, 0px)`;

        currentX = 0; currentY = 0;
        isDragging = true;
        terminal.style.opacity = '0.9';
    }

    function drag(e) {
        if (!isDragging) return;

        let clientX, clientY;
        if (e.type === 'touchmove') {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        currentX = clientX - startX;
        currentY = clientY - startY;

        // Prevent dragging above navbar (60px) and off-screen
        const rect = terminal.getBoundingClientRect();
        const newX = initialX + currentX;
        const newY = initialY + currentY;

        // Top constraint (Navbar)
        if (newY < 60) {
            currentY = 60 - initialY;
        }
        // Bottom constraint 
        else if (newY + rect.height > window.innerHeight) {
            currentY = window.innerHeight - rect.height - initialY;
        }

        // Left constraint
        if (newX < 0) {
            currentX = -initialX;
        }
        // Right constraint
        else if (newX + rect.width > window.innerWidth) {
            currentX = window.innerWidth - rect.width - initialX;
        }

        terminal.style.transform = `translate(${currentX}px, ${currentY}px)`;

        // Update live position
        const posEl = document.getElementById('debug-pos');
        if (posEl) posEl.textContent = `X:${Math.round(initialX + currentX)} Y:${Math.round(initialY + currentY)}`;
    }

    function dragEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        terminal.style.opacity = '1';

        // Apply final transform to left/top and reset transform
        const rect = terminal.getBoundingClientRect();
        terminal.style.left = `${rect.left}px`;
        terminal.style.top = `${rect.top}px`;
        terminal.style.transform = `translate(0px, 0px)`;
    }

    // ---------------------------------------------------------
    // Target Acquisition Matrix Drag & Minimize Logic
    // ---------------------------------------------------------
    const targetMatrix = document.getElementById('targetLogMatrix');
    const targetHeader = document.getElementById('targetLogHeader');
    const targetToggleBtn = document.getElementById('targetLogToggle');
    const targetBody = document.getElementById('targetLogBody');

    let isTargetDragging = false;
    let targetStartX, targetStartY;
    let targetInitialX, targetInitialY;
    let targetCurrentX = 0, targetCurrentY = 0;
    let isTargetMinimized = false;

    if (targetMatrix && targetHeader) {
        targetHeader.addEventListener('mousedown', targetDragStart);
        document.addEventListener('mousemove', targetDrag);
        document.addEventListener('mouseup', targetDragEnd);

        targetHeader.addEventListener('touchstart', targetDragStart, { passive: true });
        document.addEventListener('touchmove', targetDrag, { passive: false });
        document.addEventListener('touchend', targetDragEnd);
    }

    if (targetToggleBtn && targetBody) {
        targetToggleBtn.addEventListener('click', () => {
            isTargetMinimized = !isTargetMinimized;
            targetBody.style.display = isTargetMinimized ? 'none' : 'block';
            targetToggleBtn.textContent = isTargetMinimized ? '+' : '_';
        });
    }

    function targetDragStart(e) {
        if (e.target === targetToggleBtn) return;

        if (e.type === 'touchstart') {
            targetStartX = e.touches[0].clientX;
            targetStartY = e.touches[0].clientY;
        } else {
            targetStartX = e.clientX;
            targetStartY = e.clientY;
        }

        const rect = targetMatrix.getBoundingClientRect();
        targetInitialX = rect.left;
        targetInitialY = rect.top;

        targetMatrix.style.left = `${targetInitialX}px`;
        targetMatrix.style.top = `${targetInitialY}px`;
        targetMatrix.style.right = 'auto';
        targetMatrix.style.bottom = 'auto';
        targetMatrix.style.transform = `translate(0px, 0px)`;

        targetCurrentX = 0; targetCurrentY = 0;
        isTargetDragging = true;
        targetMatrix.style.opacity = '0.9';
        targetMatrix.style.zIndex = '9999'; // Bring to front while dragging
        terminal.style.zIndex = '9998';
    }

    function targetDrag(e) {
        if (!isTargetDragging) return;

        let clientX, clientY;
        if (e.type === 'touchmove') {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        targetCurrentX = clientX - targetStartX;
        targetCurrentY = clientY - targetStartY;

        const rect = targetMatrix.getBoundingClientRect();
        const newX = targetInitialX + targetCurrentX;
        const newY = targetInitialY + targetCurrentY;

        if (newY < 60) targetCurrentY = 60 - targetInitialY;
        else if (newY + rect.height > window.innerHeight) targetCurrentY = window.innerHeight - rect.height - targetInitialY;

        if (newX < 0) targetCurrentX = -targetInitialX;
        else if (newX + rect.width > window.innerWidth) targetCurrentX = window.innerWidth - rect.width - targetInitialX;

        targetMatrix.style.transform = `translate(${targetCurrentX}px, ${targetCurrentY}px)`;

        // Update live position
        const posEl = document.getElementById('targetLogPos');
        if (posEl) posEl.textContent = `X:${Math.round(targetInitialX + targetCurrentX)} Y:${Math.round(targetInitialY + targetCurrentY)}`;
    }

    function targetDragEnd(e) {
        if (!isTargetDragging) return;
        isTargetDragging = false;
        targetMatrix.style.opacity = '1';

        const rect = targetMatrix.getBoundingClientRect();
        targetMatrix.style.left = `${rect.left}px`;
        targetMatrix.style.top = `${rect.top}px`;
        targetMatrix.style.transform = `translate(0px, 0px)`;
    }

    // Hide loading overlay after 5 seconds regardless (failsafe)
    setTimeout(() => {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay && !overlay.classList.contains('hidden')) {
            overlay.classList.add('hidden');
        }
    }, 5000);

    // Initial explicit position update
    setTimeout(() => {
        const tRect = terminal?.getBoundingClientRect();
        if (tRect) {
            const posEl = document.getElementById('debug-pos');
            if (posEl) posEl.textContent = `X:${Math.round(tRect.left)} Y:${Math.round(tRect.top)}`;
        }
        const mRect = targetMatrix?.getBoundingClientRect();
        if (mRect) {
            const posEl = document.getElementById('targetLogPos');
            if (posEl) posEl.textContent = `X:${Math.round(mRect.left)} Y:${Math.round(mRect.top)}`;
        }
    }, 150);

    // ---------------------------------------------------------
    // Background Music (BGM) & Audio Controls
    // ---------------------------------------------------------
    const bgmPath = 'assets/audio/the_mountain-elegant-138619.mp3';
    const bgm = new Audio(bgmPath);
    bgm.loop = true;
    bgm.volume = 0.1; // 10% volume
    bgm.muted = true; // Started muted as requested by user

    // Explicit state to track the play promise and avoid race conditions
    let playPromise = null;

    const soundToggle = document.getElementById('soundToggle');
    const iconVolumeOn = soundToggle?.querySelector('.icon-volume-on');
    const iconVolumeOff = soundToggle?.querySelector('.icon-volume-off');

    const updateAudioIcon = (isMuted) => {
        if (!soundToggle || !iconVolumeOn || !iconVolumeOff) return;
        if (isMuted) {
            iconVolumeOn.style.display = 'none';
            iconVolumeOff.style.display = 'block';
            soundToggle.classList.add('muted');
            soundToggle.setAttribute('aria-label', 'Unmute Background Music');
        } else {
            iconVolumeOn.style.display = 'block';
            iconVolumeOff.style.display = 'none';
            soundToggle.classList.remove('muted');
            soundToggle.setAttribute('aria-label', 'Mute Background Music');
        }
    };

    // Toggle Mute on Button Click
    if (soundToggle) {
        soundToggle.addEventListener('click', () => {
            if (bgm.muted) {
                // User wants to UNMUTE and PLAY
                bgm.muted = false;
                updateAudioIcon(false);

                playPromise = bgm.play();
                if (playPromise !== undefined) {
                    playPromise.catch(err => {
                        console.warn("Audio play prevented:", err);
                        // Revert UI if play fails
                        bgm.muted = true;
                        updateAudioIcon(true);
                    });
                }
            } else {
                // User wants to MUTE and PAUSE
                bgm.muted = true;
                updateAudioIcon(true);

                if (playPromise !== undefined && playPromise !== null) {
                    // Wait for the pending play promise to resolve before pausing
                    playPromise.then(() => {
                        bgm.pause();
                    }).catch(err => {
                        // Play failed anyway, nothing to pause
                    });
                } else {
                    bgm.pause();
                }
            }
        });
    }


    // Initialize Native Spline Runtime on Canvas
    const canvas = document.getElementById('spline');
    if (canvas) {
        // Intercept API Event Listeners to force Spline to ignore certain events
        const originalAddEventListener = canvas.addEventListener;
        const originalRemoveEventListener = canvas.removeEventListener;
        const listenerMap = new WeakMap();

        canvas.addEventListener = function (type, listener, options) {
            // Completely disable all wheel/scroll events from reaching Spline 
            // so they bubble up naturally and trigger page scroll
            if (type === 'wheel') {
                return;
            }

            // Allow pointer events for click-and-drag, but ignore multi-touch 
            // to prevent pinch-to-zoom interaction with the Earth
            if (['pointerdown', 'pointermove', 'touchstart', 'touchmove'].includes(type)) {
                const wrappedListener = function (e) {
                    if (e.touches && e.touches.length > 1) return; // Ignore multi-touch
                    if (e.type.startsWith('pointer') && !e.isPrimary) return; // Ignore secondary pointers
                    return listener.call(this, e);
                };
                listenerMap.set(listener, wrappedListener);
                return originalAddEventListener.call(this, type, wrappedListener, options);
            }

            return originalAddEventListener.call(this, type, listener, options);
        };

        canvas.removeEventListener = function (type, listener, options) {
            if (type === 'wheel') return;
            const wrappedListener = listenerMap.get(listener);
            if (wrappedListener) {
                return originalRemoveEventListener.call(this, type, wrappedListener, options);
            }
            return originalRemoveEventListener.call(this, type, listener, options);
        };

        const app = new Application(canvas);

        app.load('https://prod.spline.design/nE6fRoE4T-EGsItu/scene.splinecode').then(() => {
            const overlay = document.getElementById('loadingOverlay');
            if (overlay && !overlay.classList.contains('hidden')) {
                overlay.classList.add('hidden');
            }

            // Continuous Infinite Rotation
            try {
                const objects = app.getObjects();
                // Find the main 3D objects (exclude lights/cameras to keep lighting consistent)
                const targets = objects.filter(obj =>
                    !obj.name.toLowerCase().includes('light') &&
                    !obj.name.toLowerCase().includes('camera') &&
                    obj.type !== 'DirectionalLight' &&
                    obj.type !== 'SpotLight' &&
                    (obj.parent && obj.parent.type === 'Scene' || obj.type === 'Group')
                );

                if (targets.length > 0) {
                    const rotateForever = () => {
                        targets.forEach(target => {
                            if (target && target.rotation !== undefined) {
                                // Apply constant rotation. Adjust increment to change speed.
                                target.rotation.y += 0.003;
                            }
                        });
                        requestAnimationFrame(rotateForever);
                    };
                    requestAnimationFrame(rotateForever);
                }
            } catch (err) {
                console.warn('Could not initialize continuous rotation:', err);
            }
        }).catch(err => {
            console.error('Failed to load Spline scene', err);
        });
    }

    // ---------------------------------------------------------
    // Gallery 3D Slider Logic
    // ---------------------------------------------------------
    const sliderCards = document.querySelectorAll('.slider-card');
    if (sliderCards.length > 0) {
        let activeIndex = 0;
        const totalCards = sliderCards.length;

        function updateSlider() {
            sliderCards.forEach((card, index) => {
                // Remove all state classes
                card.classList.remove('active', 'prev-1', 'next-1', 'prev-2', 'next-2');

                // Calculate circular distance
                let diff = (index - activeIndex + totalCards) % totalCards;
                // Optimize diff to be backward/forward relative
                if (diff > Math.floor(totalCards / 2)) {
                    diff -= totalCards;
                }

                if (diff === 0) {
                    card.classList.add('active');
                } else if (diff === -1 || diff === totalCards - 1) { // Prev 1
                    card.classList.add('prev-1');
                } else if (diff === 1 || diff === -(totalCards - 1)) { // Next 1
                    card.classList.add('next-1');
                } else if (diff === -2 || diff === totalCards - 2) { // Prev 2
                    card.classList.add('prev-2');
                } else if (diff === 2 || diff === -(totalCards - 2)) { // Next 2
                    card.classList.add('next-2');
                }
            });
        }

        // Initialize First View
        updateSlider();

        // Autoplay
        let sliderInterval = setInterval(() => {
            activeIndex = (activeIndex + 1) % totalCards;
            updateSlider();
        }, 3000);

        // Click to Focus
        sliderCards.forEach((card, index) => {
            card.addEventListener('click', () => {
                activeIndex = index;
                updateSlider();

                // Reset interval on manual click
                clearInterval(sliderInterval);
                sliderInterval = setInterval(() => {
                    activeIndex = (activeIndex + 1) % totalCards;
                    updateSlider();
                }, 3000);
            });
        });
    }

    // ---------------------------------------------------------
    // Hero Typing Animation
    // ---------------------------------------------------------
    const typedTextSpan = document.getElementById("typed-text");
    if (typedTextSpan) {
        const staticLine = "Anirban.<br>";
        const rotatingWords = ["Roy.", "Engineer.", "XYZ.", "YZX."];

        const typingDelay = 100;
        const erasingDelay = 60;
        const newTextDelay = 2000; // Delay before starting to erase

        let wordIndex = 0;
        let charIndex = 0;
        let isStaticTyped = false;

        function typeStaticAndStart() {
            let staticHTML = "";
            let staticIndex = 0;
            const staticText = "Anirban.";

            function typeS() {
                if (staticIndex < staticText.length) {
                    staticHTML += staticText.charAt(staticIndex);
                    typedTextSpan.innerHTML = staticHTML;
                    staticIndex++;
                    setTimeout(typeS, typingDelay);
                } else {
                    // Inject line break once static part is done
                    staticHTML += "<br>";
                    typedTextSpan.innerHTML = staticHTML;
                    isStaticTyped = true;
                    setTimeout(typeWord, 500); // Start the infinite loop
                }
            }
            typeS();
        }

        function typeWord() {
            if (charIndex < rotatingWords[wordIndex].length) {
                typedTextSpan.innerHTML = "Anirban.<br>" + rotatingWords[wordIndex].substring(0, charIndex + 1);
                charIndex++;
                setTimeout(typeWord, typingDelay);
            } else {
                setTimeout(eraseWord, newTextDelay);
            }
        }

        function eraseWord() {
            if (charIndex > 0) {
                typedTextSpan.innerHTML = "Anirban.<br>" + rotatingWords[wordIndex].substring(0, charIndex - 1);
                charIndex--;
                setTimeout(eraseWord, erasingDelay);
            } else {
                wordIndex++;
                if (wordIndex >= rotatingWords.length) wordIndex = 0;
                setTimeout(typeWord, typingDelay + 300);
            }
        }

        // Start initial static typing delay
        setTimeout(typeStaticAndStart, 800);
    }

    // ---------------------------------------------------------
    // Shooting Stars Effect
    // ---------------------------------------------------------
    function spawnShootingStar() {
        // Random chance to spawn (very random low rate)
        if (Math.random() > 0.2) { // 80% chance to actually spawn when interval hits
            const star = document.createElement('div');
            star.className = 'shooting-star';

            // Random starting position (mostly top and left to travel diagonally down-right)
            const startX = Math.random() * (window.innerWidth / 1.5) - 200;
            const startY = Math.random() * (window.innerHeight / 2) - 200;

            star.style.left = `${startX}px`;
            star.style.top = `${startY}px`;

            document.body.appendChild(star);

            // Clean up after animation duration
            setTimeout(() => {
                if (document.body.contains(star)) {
                    star.remove();
                }
            }, 2000);
        }

        // Schedule next random attempt between 3s and 10s
        const nextSpawn = 3000 + Math.random() * 7000;
        setTimeout(spawnShootingStar, nextSpawn);
    }

    // Initialize shooting stars with initial delay
    setTimeout(spawnShootingStar, 2000);
});
