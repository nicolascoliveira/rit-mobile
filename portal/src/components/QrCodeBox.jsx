import React, { useEffect, useRef } from 'react';
import { generate, correction } from 'lean-qr';

function hexToRgba(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/**
 * Renderiza um QR Code real (ISO-18004) em Canvas com contraste máximo para leitura imediata na recepção.
 */
export default function QrCodeBox({ value, size = 168 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    try {
      const code = generate(String(value), { minCorrectionLevel: correction.M });
      code.toCanvas(canvas, {
        on: hexToRgba('#000000'),
        off: hexToRgba('#ffffff'),
        padX: 3,
        padY: 3
      });
    } catch (e) {
      console.warn('Erro ao gerar QR:', e);
    }
  }, [value]);

  return (
    <div className="b2b-qr-frame" style={{ width: size, height: size }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', imageRendering: 'pixelated', borderRadius: 10, display: 'block' }}
      />
    </div>
  );
}
