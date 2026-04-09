import * as THREE from 'three';

export const surfaceShader = {
    uniforms: {
        tDepth: { value: null },
        tOpaque: { value: null },
        tThickness: { value: null },
        // MISSING: Added the environment map uniform here
        tEnvMap: { value: null }, 
        uResolution: { value: new THREE.Vector2(window.innerWidth * window.devicePixelRatio, window.innerHeight * window.devicePixelRatio) },
        uDeepColor: { value: new THREE.Color(0x001133) },   
        uShallowColor: { value: new THREE.Color(0x44aaff) } 
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
        uniform sampler2D tOpaque;
        uniform sampler2D tThickness;
        // MISSING: Added the samplerCube declaration
        uniform samplerCube tEnvMap; 
        uniform vec2 uResolution;
        uniform vec3 uDeepColor;
        uniform vec3 uShallowColor;
        varying vec2 vUv;

        void main() {
            float depth = texture2D(tDepth, vUv).r;
            if (depth <= 0.1 || depth > 100.0) {
                gl_FragColor = texture2D(tOpaque, vUv);
                return;
            }

            float thickness = texture2D(tThickness, vUv).r;

            vec2 texelSize = 1.0 / uResolution;
            float d = depth;
            float d_x = texture2D(tDepth, vUv + vec2(texelSize.x, 0.0)).r;
            float d_y = texture2D(tDepth, vUv + vec2(0.0, texelSize.y)).r;

            vec3 nx = vec3(1.0, 0.0, (d_x - d) * 15.0); 
            vec3 ny = vec3(0.0, 1.0, (d_y - d) * 15.0);
            vec3 normal = normalize(cross(nx, ny));

            // --- REFRACTION ---
            float refStrength = 0.05 + (thickness * 0.02); 
            vec2 distortedUv = vUv - (normal.xy * refStrength);
            vec3 bgColor = texture2D(tOpaque, distortedUv).rgb;

            // --- BEER-LAMBERT TINTING ---
            float absorption = 1.0; 
            float transmission = exp(-thickness * absorption);
            vec3 waterColor = mix(uDeepColor, uShallowColor, transmission);
            vec3 tintedWater = mix(waterColor, bgColor, transmission * 0.8);

            // --- REFLECTION & LIGHTING ---
            // Calculate View Direction (In screen space, forward is usually -Z)
            vec3 viewDir = normalize(vec3(vUv * 2.0 - 1.0, -1.0));
            vec3 reflectDir = reflect(viewDir, normal);
            
            // Sample the environment map (Skybox)
            vec3 envColor = textureCube(tEnvMap, reflectDir).rgb;

            // Fresnel determines how much the surface acts like a mirror
            float fresnel = pow(1.0 - max(dot(normal, vec3(0,0,1)), 0.0), 3.0);

            // FIXED: Combined into one finalColor declaration to avoid redeclaration error
            vec3 combinedColor = mix(tintedWater, envColor, fresnel * 0.5);
            
            // Add Specular Sun Glint
            vec3 sunDir = normalize(vec3(0.5, 1.0, 0.5));
            float specular = pow(max(dot(reflectDir, sunDir), 0.0), 32.0);
            vec3 finalColor = combinedColor + (vec3(1.0) * specular);

            gl_FragColor = vec4(finalColor, 1.0);
        }
    `
};