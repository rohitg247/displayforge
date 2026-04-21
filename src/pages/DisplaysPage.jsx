import { useState } from 'react';
import { Plus, Edit2, Trash2, Monitor } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { ActisButton } from '@/components/admin/ActisButton';
import { ActisInput } from '@/components/admin/ActisInput';
import { ActisCard, ActisCardContent } from '@/components/admin/ActisCard';
import { ActisModal } from '@/components/admin/ActisModal';
import { motion } from 'framer-motion';
import { toast } from '@/components/ui/sonner';

export function DisplaysPage() {
  const { state, addDisplay, editDisplay, deleteDisplay } = useApp();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [selectedBranch, setSelectedBranch] = useState(state.branches[0]?.id || '');
  const [displayName, setDisplayName] = useState('');

  const handleAddDisplay = async () => {
    if (displayName.trim()) {
      try {
        await addDisplay(selectedBranch, displayName);
        toast.success('Display created');
        setDisplayName('');
        setIsModalOpen(false);
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleEditDisplay = (branchId, displayId, currentName) => {
    setEditingId(displayId);
    setSelectedBranch(branchId);
    setDisplayName(currentName);
    setIsModalOpen(true);
  };

  const handleSaveEdit = async () => {
    if (displayName.trim() && editingId) {
      try {
        await editDisplay(selectedBranch, editingId, displayName);
        toast.success('Display updated');
        setDisplayName('');
        setEditingId(null);
        setIsModalOpen(false);
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleDeleteDisplay = async (branchId, displayId) => {
    if (window.confirm('Are you sure?')) {
      try {
        await deleteDisplay(branchId, displayId);
        toast.success('Display deleted');
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setDisplayName('');
  };

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">Displays Manager</h2>
          <p className="text-muted-foreground mt-1">Create and manage your display screens</p>
        </div>
        <ActisButton
          variant="primary"
          onClick={() => {
            setEditingId(null);
            setDisplayName('');
            setSelectedBranch(state.branches[0]?.id || '');
            setIsModalOpen(true);
          }}
        >
          <Plus size={18} />
          Add Display
        </ActisButton>
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
          </div>

          {branch.displays.length === 0 ? (
            <p className="text-muted-foreground text-sm pl-4">No displays</p>
          ) : (
            <div className="space-y-3">
              {branch.displays.map((display) => (
                <ActisCard key={display.id} hover>
                  <ActisCardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Monitor size={16} className="text-primary" />
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">{display.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {display.pages.caseStudies.length} case studies
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <ActisButton
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditDisplay(branch.id, display.id, display.name)}
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
                    </div>
                  </ActisCardContent>
                </ActisCard>
              ))}
            </div>
          )}
        </motion.div>
      ))}

      <ActisModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        title={editingId ? 'Edit Display' : 'Add Display'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Branch</label>
            <select
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-border bg-input text-foreground focus:outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all duration-200"
            >
              {state.branches.map((branch) => (
                <option key={branch.id} value={branch.id} className="bg-card">
                  {branch.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-2">Display Name</label>
            <ActisInput
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter display name"
            />
          </div>

          <div className="flex gap-2 pt-4">
            <ActisButton
              variant="primary"
              onClick={editingId ? handleSaveEdit : handleAddDisplay}
              className="flex-1"
            >
              {editingId ? 'Update' : 'Add'}
            </ActisButton>
            <ActisButton variant="outline" onClick={handleCloseModal} className="flex-1">
              Cancel
            </ActisButton>
          </div>
        </div>
      </ActisModal>
    </div>
  );
}
