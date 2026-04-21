import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, Edit2, Trash2, Monitor, FolderOpen, Tv2, Film, Image } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { api } from '@/services/api';
import { ActisButton } from '@/components/admin/ActisButton';
import { ActisCard, ActisCardHeader, ActisCardContent, ActisCardFooter } from '@/components/admin/ActisCard';
import { motion } from 'framer-motion';
import { toast } from '@/components/ui/sonner';

export function DashboardPage() {
  const { state, deleteDisplay } = useApp();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('interactive');
  const [ambientDisplays, setAmbientDisplays] = useState([]);

  useEffect(() => {
    if (activeTab === 'ambient') {
      api.getAmbientDisplays().then(setAmbientDisplays).catch(console.error);
    }
  }, [activeTab]);

  const handleViewDisplay = (displayId) => {
    window.open(`/branch/${displayId}`, '_blank');
  };

  const handleEditDisplay = (displayId) => {
    navigate(`/admin/displays/${displayId}/editor`);
  };

  const handleDeleteDisplay = async (branchId, displayId) => {
    if (window.confirm('Are you sure you want to delete this display?')) {
      try {
        await deleteDisplay(branchId, displayId);
        toast.success('Display deleted');
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleDeleteAmbient = async (id) => {
    if (!window.confirm('Delete this ambient display?')) return;
    try {
      await api.deleteAmbientDisplay(id);
      setAmbientDisplays((prev) => prev.filter((d) => d.id !== id));
    } catch (err) { toast.error(err.message); }
  };

  const totalDisplays = state.branches.reduce((acc, b) => acc + b.displays.length, 0);
  const totalCaseStudies = state.branches.reduce(
    (acc, b) => acc + b.displays.reduce((a, d) => a + d.pages.caseStudies.length, 0),
    0
  );

  const totalAmbientMedia = ambientDisplays.reduce((acc, d) => acc + (d.media_count || 0), 0);

  // Group ambient displays by branch
  const branchMap = {};
  state.branches.forEach((b) => { branchMap[b.id] = b.name; });
  const ambientGrouped = {};
  ambientDisplays.forEach((d) => {
    if (!ambientGrouped[d.branch_id]) ambientGrouped[d.branch_id] = [];
    ambientGrouped[d.branch_id].push(d);
  });

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-foreground tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground mt-1">Manage your displays and case studies</p>
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1 p-1 rounded-xl bg-secondary/60 mb-8 w-fit">
        {[
          { key: 'interactive', label: 'Interactive Displays', icon: Monitor },
          { key: 'ambient', label: 'Ambient Displays', icon: Tv2 },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all duration-200 ${
              activeTab === tab.key
                ? 'gradient-primary text-primary-foreground glow-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'interactive' ? (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-10">
            {[
              { label: 'Branches', value: state.branches.length, icon: FolderOpen },
              { label: 'Displays', value: totalDisplays, icon: Monitor },
              { label: 'Case Studies', value: totalCaseStudies, icon: Edit2 },
            ].map((stat) => (
              <ActisCard key={stat.label} className="p-5">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <stat.icon size={18} className="text-primary" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{stat.value}</p>
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                  </div>
                </div>
              </ActisCard>
            ))}
          </div>

          {state.branches.map((branch, bIdx) => (
            <motion.div
              key={branch.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: bIdx * 0.1 }}
              className="mb-10"
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="w-1.5 h-6 rounded-full gradient-accent" />
                <h3 className="text-lg font-bold text-foreground">{branch.name}</h3>
                <span className="text-xs text-muted-foreground ml-2">
                  {branch.displays.length} display{branch.displays.length !== 1 ? 's' : ''}
                </span>
              </div>

              {branch.displays.length === 0 ? (
                <p className="text-muted-foreground text-sm pl-4">No displays for this branch</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {branch.displays.map((display) => (
                    <ActisCard key={display.id} hover>
                      <ActisCardHeader>
                        <h4 className="text-base font-semibold text-foreground">{display.name}</h4>
                        <p className="text-xs text-muted-foreground mt-1">
                          {display.pages.caseStudies.length} case{' '}
                          {display.pages.caseStudies.length !== 1 ? 'studies' : 'study'}
                        </p>
                      </ActisCardHeader>
                      <ActisCardFooter>
                        <ActisButton
                          variant="primary"
                          size="sm"
                          onClick={() => handleViewDisplay(display.id)}
                          className="flex-1"
                        >
                          <Eye size={14} />
                          View
                        </ActisButton>
                        <ActisButton
                          variant="secondary"
                          size="sm"
                          onClick={() => handleEditDisplay(display.id)}
                          className="flex-1"
                        >
                          <Edit2 size={14} />
                          Edit
                        </ActisButton>
                        <ActisButton
                          variant="danger"
                          size="sm"
                          onClick={() => handleDeleteDisplay(branch.id, display.id)}
                        >
                          <Trash2 size={14} />
                        </ActisButton>
                      </ActisCardFooter>
                    </ActisCard>
                  ))}
                </div>
              )}
            </motion.div>
          ))}
        </>
      ) : (
        <>
          {/* Ambient Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
            {[
              { label: 'Ambient Displays', value: ambientDisplays.length, icon: Tv2 },
              { label: 'Total Media Items', value: totalAmbientMedia, icon: Film },
            ].map((stat) => (
              <ActisCard key={stat.label} className="p-5">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                    <stat.icon size={18} className="text-accent" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-foreground">{stat.value}</p>
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                  </div>
                </div>
              </ActisCard>
            ))}
          </div>

          {Object.entries(ambientGrouped).map(([branchId, branchDisplays], bIdx) => (
            <motion.div
              key={branchId}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: bIdx * 0.1 }}
              className="mb-10"
            >
              <div className="flex items-center gap-2 mb-4">
                <div className="w-1.5 h-6 rounded-full gradient-accent" />
                <h3 className="text-lg font-bold text-foreground">
                  {branchMap[branchId] || `Branch ${branchId}`}
                </h3>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {branchDisplays.map((d) => (
                  <ActisCard key={d.id} hover>
                    <ActisCardHeader>
                      <h4 className="text-base font-semibold text-foreground">{d.name}</h4>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground">
                          {d.orientation}
                        </span>
                        <span className="text-xs text-muted-foreground">{d.media_count} media</span>
                      </div>
                    </ActisCardHeader>
                    <ActisCardFooter>
                      <ActisButton
                        variant="primary"
                        size="sm"
                        onClick={() => window.open(`/ambient/${d.id}`, '_blank')}
                        className="flex-1"
                      >
                        <Eye size={14} /> View
                      </ActisButton>
                      <ActisButton
                        variant="danger"
                        size="sm"
                        onClick={() => handleDeleteAmbient(d.id)}
                      >
                        <Trash2 size={14} />
                      </ActisButton>
                    </ActisCardFooter>
                  </ActisCard>
                ))}
              </div>
            </motion.div>
          ))}

          {ambientDisplays.length === 0 && (
            <p className="text-muted-foreground text-sm">No ambient displays yet.</p>
          )}
        </>
      )}
    </div>
  );
}
