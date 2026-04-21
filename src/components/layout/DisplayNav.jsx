import { ChevronLeft, ChevronRight, Home, Users, BookOpen, Lightbulb } from 'lucide-react';

const navItems = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'about', label: 'About Us', icon: Users },
  { id: 'caseStudies', label: 'Case Studies', icon: BookOpen },
  { id: 'solutions', label: 'Solutions', icon: Lightbulb },
];

export function DisplayNav({ activePage, setActivePage, currentIndex, totalPages, handlePrev, handleNext, isFirst, isLast  }) {
  return (
    <nav
      style={{
        position: 'absolute',
        bottom: '6%',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 20,
        height: 'clamp(40px, 5.5vh, 64px)',
        backgroundColor: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(10px)',
        borderRadius: '999px',
        border: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 clamp(8px, 1.2vw, 16px)',
        gap: 'clamp(2px, 0.4vw, 6px)',
        whiteSpace: 'nowrap',
      }}
    >
      {/* Left — Home, About Us */}
      {navItems.slice(0, 2).map((item) => {
        const Icon = item.icon;
        const isActive = activePage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setActivePage(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'clamp(5px, 0.7vw, 10px)',
              padding: 'clamp(5px, 0.8vh, 10px) clamp(12px, 1.8vw, 22px)',
              borderRadius: '999px',
              backgroundColor: isActive ? '#e8362a' : 'transparent',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 'clamp(12px, 1.3vw, 16px)',
              border: 'none',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            <Icon size={16} />
            {item.label}
          </button>
        );
      })}

      {/* Divider */}
      <div style={{ width: '1px', height: 'clamp(16px, 2.5vh, 30px)', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 4px' }} />

      {/* Center — Global Pagination */}
        <>
          <button
            onClick={handlePrev}
            disabled={isFirst}
            style={{
              width: 'clamp(22px, 2.8vw, 34px)',
              height: 'clamp(22px, 2.8vw, 34px)',
              borderRadius: '50%',
              backgroundColor: 'rgba(255,255,255,0.15)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              flexShrink: 0,
              opacity: isFirst ? 0.3 : 1,
              cursor: isFirst ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronLeft size={15} />
          </button>
          <span style={{ color: '#ffffff', fontSize: 'clamp(11px, 1.2vw, 15px)', fontWeight: 500, padding: '0 4px' }}>
            {currentIndex + 1} / {totalPages}
          </span>
          <button
            onClick={handleNext}
            disabled={isLast}
            style={{
              width: 'clamp(22px, 2.8vw, 34px)',
              height: 'clamp(22px, 2.8vw, 34px)',
              borderRadius: '50%',
              backgroundColor: 'rgba(255,255,255,0.15)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ffffff',
              flexShrink: 0,
              opacity: isLast ? 0.3 : 1,
              cursor: isLast ? 'not-allowed' : 'pointer',
            }}
          >
            <ChevronRight size={15} />
          </button>
          {/* Divider */}
          <div style={{ width: '1px', height: 'clamp(16px, 2.5vh, 30px)', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 4px' }} />
        </>

      {/* Right — Case Studies, Solutions */}
      {navItems.slice(2).map((item) => {
        const Icon = item.icon;
        const isActive = activePage === item.id;
        return (
          <button
            key={item.id}
            onClick={() => setActivePage(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'clamp(5px, 0.7vw, 10px)',
              padding: 'clamp(5px, 0.8vh, 10px) clamp(12px, 1.8vw, 22px)',
              borderRadius: '999px',
              backgroundColor: isActive ? '#e8362a' : 'transparent',
              color: '#ffffff',
              fontWeight: 600,
              fontSize: 'clamp(12px, 1.3vw, 16px)',
              border: 'none',
              cursor: 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            <Icon size={16} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
