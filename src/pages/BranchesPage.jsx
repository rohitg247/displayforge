import { useState } from 'react';
import { Plus, Edit2, Trash2, Building2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { ActisButton } from '@/components/admin/ActisButton';
import { ActisInput } from '@/components/admin/ActisInput';
import { ActisCard, ActisCardContent } from '@/components/admin/ActisCard';
import { ActisModal } from '@/components/admin/ActisModal';
import { motion } from 'framer-motion';
import { toast } from '@/components/ui/sonner';

export function BranchesPage() {
  const { state, addBranch, editBranch, deleteBranch } = useApp();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [branchName, setBranchName] = useState('');

  const handleAdd = async () => {
    if (branchName.trim()) {
      try {
        await addBranch(branchName);
        toast.success('Branch created');
        setBranchName('');
        setIsModalOpen(false);
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleEdit = (branch) => {
    setEditingId(branch.id);
    setBranchName(branch.name);
    setIsModalOpen(true);
  };

  const handleSaveEdit = async () => {
    if (branchName.trim() && editingId) {
      try {
        await editBranch(editingId, branchName);
        toast.success('Branch updated');
        setEditingId(null);
        setBranchName('');
        setIsModalOpen(false);
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const handleDelete = async (branch) => {
    if (window.confirm('Delete this branch?')) {
      try {
        await deleteBranch(branch.id);
        toast.success('Branch deleted');
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingId(null);
    setBranchName('');
  };

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">
            Branch Manager
          </h2>
          <p className="text-muted-foreground mt-1">
            Manage company branches
          </p>
        </div>
        <ActisButton
          variant="primary"
          onClick={() => {
            setEditingId(null);
            setBranchName('');
            setIsModalOpen(true);
          }}
        >
          <Plus size={18} />
          Add Branch
        </ActisButton>
      </div>

      {state.branches.length === 0 ? (
        <p className="text-muted-foreground">No branches available.</p>
      ) : (
        <div className="space-y-4">
          {state.branches.map((branch, index) => (
            <motion.div
              key={branch.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.08 }}
            >
              <ActisCard hover>
                <ActisCardContent className="flex items-center justify-between p-5">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Building2 size={18} className="text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold text-foreground">
                        {branch.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {branch.displays.length} displays
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <ActisButton
                      variant="outline"
                      size="sm"
                      onClick={() => handleEdit(branch)}
                    >
                      <Edit2 size={14} />
                      Edit
                    </ActisButton>
                    <ActisButton
                      variant="danger"
                      size="sm"
                      onClick={() => handleDelete(branch)}
                    >
                      <Trash2 size={14} />
                    </ActisButton>
                  </div>
                </ActisCardContent>
              </ActisCard>
            </motion.div>
          ))}
        </div>
      )}

      <ActisModal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={editingId ? 'Edit Branch' : 'Add Branch'}
      >
        <div className="space-y-4">
          <ActisInput
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="Enter branch name"
          />

          <div className="flex gap-2 pt-4">
            <ActisButton
              variant="primary"
              onClick={editingId ? handleSaveEdit : handleAdd}
              className="flex-1"
            >
              {editingId ? 'Update' : 'Add'}
            </ActisButton>

            <ActisButton
              variant="outline"
              onClick={closeModal}
              className="flex-1"
            >
              Cancel
            </ActisButton>
          </div>
        </div>
      </ActisModal>
    </div>
  );
}