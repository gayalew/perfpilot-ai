import React, { useEffect, useState } from 'react';

export default function SlowApp() {
  const [heavyData, setHeavyData] = useState<number[]>([]);

  // Simulate a long task / blocking JavaScript execution on load
  useEffect(() => {
    const start = performance.now();
    while (performance.now() - start < 300) {
      // Block main thread for 300ms
    }
    setHeavyData(Array.from({ length: 5000 }, (_, i) => i));
  }, []);

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>Welcome to the Unoptimized PerfPilot Sample</h1>
      <p>This page is deliberately built to fail performance audits so our engine can fix it.</p>

      {/* Render-blocking large images without lazy loading or sizing */}
      <div style={{ margin: '20px 0' }}>
        <h2>Heavy Unoptimized Images</h2>
        <img 
          src="https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=4000&q=90" 
          alt="Massive mountain landscape" 
          style={{ width: '100%', height: 'auto' }}
        />
        <img 
          src="https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=4000&q=90" 
          alt="Forest fog" 
          style={{ width: '100%', height: 'auto', marginTop: '20px' }}
        />
      </div>

      {/* Heavy list rendering without virtualization */}
      <div>
        <h2>Heavy DOM Elements</h2>
        <ul>
          {heavyData.map((item) => (
            <li key={item}>Item number {item} rendered synchronously</li>
          ))}
        </ul>
      </div>
    </div>
  );
}