import * as THREE from 'three';

export const blurShader = {
    uniforms: {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uDirection: { value: new THREE.Vector2(1.0, 0.0) }, // (1,0) for X, (0,1) for Y
        uBlurRadius: { value: 6.0 }, // Higher = smoother water, but slower
        uDepthFalloff: { value: 1.5 } // How strict the sharp edges are
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uDirection;
        uniform float uBlurRadius;
        uniform float uDepthFalloff;
        varying vec2 vUv;

        void main() {
            float centerDepth = texture2D(tDepth, vUv).r;
            
            // Ignore background pixels
            if (centerDepth <= 0.1 || centerDepth > 100.0) {
                gl_FragColor = vec4(centerDepth, 0.0, 0.0, 1.0);
                return;
            }

            vec2 texelSize = 1.0 / uResolution;
            float sum = 0.0;
            float weightSum = 0.0;

            // Gaussian spatial sigma
            float blurSigma = uBlurRadius * 0.5;

            // Loop through neighboring pixels
            for(float i = -15.0; i <= 15.0; i += 1.0) {
                if (i > uBlurRadius || i < -uBlurRadius) continue;
                
                vec2 sampleUv = vUv + (uDirection * texelSize * i);
                float sampleDepth = texture2D(tDepth, sampleUv).r;
                
                // 1. Spatial Weight (closer pixels = higher weight)
                float spatialWeight = exp(-(i * i) / (2.0 * blurSigma * blurSigma));
                
                // 2. Range Weight (closer DEPTH = higher weight)
                // This is what makes it a "Bilateral" filter. It stops the blur at sharp edges.
                float depthDiff = centerDepth - sampleDepth;
                float rangeWeight = exp(-(depthDiff * depthDiff) / (2.0 * uDepthFalloff * uDepthFalloff));
                
                float weight = spatialWeight * rangeWeight;
                
                sum += sampleDepth * weight;
                weightSum += weight;
            }

            gl_FragColor = vec4(sum / weightSum, 0.0, 0.0, 1.0);
        }
    `
};