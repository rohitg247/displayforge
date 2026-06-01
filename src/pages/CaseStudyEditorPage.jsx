import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Trash2, Eye, FileText } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { ActisButton } from '@/components/admin/ActisButton';
import { ActisInput } from '@/components/admin/ActisInput';
import { ActisCard } from '@/components/admin/ActisCard';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/sonner';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function CaseStudyEditorPage() {
  const { id: displayId } = useParams();
  const {
    state,
    addCaseStudy,
    editCaseStudy,
    deleteCaseStudy,
    uploadThumbnails,
    publishCaseStudy,
    unpublishCaseStudy,
  } = useApp();

  const [editingId, setEditingId] = useState(null);
  const [formData, setFormData] = useState({
    category: '',
    title: '',
    bulletPoints: [''],
    thumbnails: [],
  });
  const [thumbnailPreviews, setThumbnailPreviews] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([null, null, null]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isPublished, setIsPublished] = useState(0);

  const display = state.branches
    .flatMap((b) => b.displays)
    .find((d) => d.id === Number(displayId));

  const branchId = state.branches.find(b => b.displays.some(d => d.id === Number(displayId)))?.id;

  const caseStudies = display?.pages.caseStudies || [];

  useEffect(() => {
    if (caseStudies.length === 0) return;

    const selectedStillExists = caseStudies.some((cs) => cs.id === editingId);

    if (!editingId || !selectedStillExists) {
      handleSelectCaseStudy(caseStudies[0]);
      return;
    }

    const latestSelected = caseStudies.find((cs) => cs.id === editingId);
    if (latestSelected) {
      handleSelectCaseStudy(latestSelected);
    }
    // Intentionally fires only when the caseStudies list changes: it (re)selects a valid case study
    // and syncs the selected one to latest data. `editingId` is read but must NOT be a trigger
    // (re-running on every selection would reset the form), and `handleSelectCaseStudy` is recreated
    // each render (adding it would cause an infinite loop). Deps stay [caseStudies] by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseStudies]);

  const handleSelectCaseStudy = (cs) => {
    setEditingId(cs.id);
    setIsPublished(cs.isPublished ?? 0);
    setFormData({
      category: cs.category,
      title: cs.title,
      bulletPoints: cs.bulletPoints?.length > 0 ? cs.bulletPoints : [''],
      thumbnails: cs.thumbnails || [],
    });
    setThumbnailPreviews(
      (cs.thumbnails || []).map((t) =>
        t.startsWith('/uploads/') ? `${API_BASE}${t}` : t
      )
    );
    setPendingFiles([null, null, null]);
  };

  const handlePublish = async () => {
    if (!editingId) return;
    setPublishing(true);
    try {
      await publishCaseStudy(Number(displayId), editingId);
      setIsPublished(1);
      toast.success('Case study published');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const handleUnpublish = async () => {
    if (!editingId) return;
    setPublishing(true);
    try {
      await unpublishCaseStudy(Number(displayId), editingId);
      setIsPublished(0);
      toast.success('Case study unpublished');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPublishing(false);
    }
  };

  const handleThumbnailChange = (e, index) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      toast.error('Invalid file type. Only JPEG, PNG, and WebP are allowed.');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('File too large. Maximum size is 5MB.');
      return;
    }

    const newFiles = [...pendingFiles];
    newFiles[index] = file;
    setPendingFiles(newFiles);

    const newPreviews = [...thumbnailPreviews];
    newPreviews[index] = URL.createObjectURL(file);
    setThumbnailPreviews(newPreviews);
  };

  const handleAddBulletPoint = () => {
    setFormData({ ...formData, bulletPoints: [...formData.bulletPoints, ''] });
  };

  const handleRemoveBulletPoint = (index) => {
    setFormData({
      ...formData,
      bulletPoints: formData.bulletPoints.filter((_, i) => i !== index),
    });
  };

  const handleBulletPointChange = (index, value) => {
    const newBullets = [...formData.bulletPoints];
    newBullets[index] = value;
    setFormData({ ...formData, bulletPoints: newBullets });
  };

  const handleSave = async () => {
    if (!formData.title.trim()) {
      toast.error('Please enter a title');
      return;
    }

    setSaving(true);
    try {
      let caseStudyId = editingId;

      if (editingId) {
        await editCaseStudy(Number(displayId), editingId, formData);
      } else {
        const created = await addCaseStudy(Number(displayId), formData);
        caseStudyId = created.id;
        setEditingId(caseStudyId);
      }

      const filesToUpload = pendingFiles.filter((f) => f !== null);
      if (filesToUpload.length > 0 && caseStudyId) {
        await uploadThumbnails(caseStudyId, filesToUpload);
        setPendingFiles([null, null, null]);
      }

      toast.success('Case study saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (caseStudyId) => {
    if (window.confirm('Delete this case study?')) {
      try {
        await deleteCaseStudy(Number(displayId), caseStudyId);
        toast.success('Case study deleted');
        setEditingId(null);
        setFormData({ category: '', title: '', bulletPoints: [''], thumbnails: [] });
        setThumbnailPreviews([]);
        setPendingFiles([null, null, null]);
      } catch (err) {
        toast.error(err.message);
      }
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setIsPublished(0);
    setFormData({ category: '', title: '', bulletPoints: [''], thumbnails: [] });
    setThumbnailPreviews([]);
    setPendingFiles([null, null, null]);
  };

  if (!display) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        Display not found
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-foreground tracking-tight">
            {display.name}
          </h2>
          <p className="text-muted-foreground mt-1">Case Study Editor</p>
        </div>
        <ActisButton
          variant="primary"
          onClick={() => window.open(`/${branchId}/1/${displayId}?preview=true`, '_blank')}
        >
          <Eye size={18} />
          Preview
        </ActisButton>
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-1 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              Case Studies
            </p>
            <span className="text-xs text-muted-foreground">{caseStudies.length}</span>
          </div>

          {caseStudies.length === 0 ? (
            <p className="text-muted-foreground text-sm">No case studies yet</p>
          ) : (
            <div className="space-y-2">
              {caseStudies.map((cs) => (
                <motion.button
                  key={cs.id}
                  whileHover={{ x: 2 }}
                  onClick={() => handleSelectCaseStudy(cs)}
                  className={cn(
                    'w-full text-left p-3 rounded-lg transition-all duration-200 border',
                    editingId === cs.id
                      ? 'gradient-accent text-accent-foreground border-accent/30 glow-accent'
                      : 'bg-card border-border text-foreground hover:bg-secondary'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium truncate text-sm">{cs.title || 'Untitled'}</p>
                    <span
                      className={cn(
                        'w-2 h-2 rounded-full flex-shrink-0',
                        cs.isPublished ? 'bg-green-400' : 'bg-gray-500'
                      )}
                      title={cs.isPublished ? 'Published' : 'Draft'}
                    />
                  </div>
                  <p className="text-xs opacity-70 mt-0.5">{cs.category}</p>
                </motion.button>
              ))}
            </div>
          )}

          <ActisButton variant="accent" className="w-full" onClick={resetForm}>
            <Plus size={16} />
            New Case Study
          </ActisButton>
        </div>

        <ActisCard className="col-span-2 p-6">
          <div className="flex items-center gap-2 mb-6">
            <FileText size={18} className="text-primary" />
            <h3 className="text-lg font-bold text-foreground">
              {editingId ? 'Edit' : 'New'} Case Study
            </h3>
          </div>

          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Category
              </label>
              <ActisInput
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                placeholder="e.g., Corporate, Retail, Healthcare"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Title
              </label>
              <ActisInput
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Case study title"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Bullet Points
              </label>
              <div className="space-y-2">
                {formData.bulletPoints.map((bullet, index) => (
                  <div key={index} className="flex gap-2">
                    <ActisInput
                      value={bullet}
                      onChange={(e) => handleBulletPointChange(index, e.target.value)}
                      placeholder="Enter bullet point"
                    />
                    <ActisButton
                      variant="danger"
                      size="sm"
                      onClick={() => handleRemoveBulletPoint(index)}
                    >
                      <Trash2 size={14} />
                    </ActisButton>
                  </div>
                ))}
              </div>
              <ActisButton
                variant="secondary"
                size="sm"
                onClick={handleAddBulletPoint}
                className="mt-2 w-full"
              >
                <Plus size={14} />
                Add Bullet
              </ActisButton>
            </div>

            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                Thumbnails (up to 3)
              </label>
              <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((index) => (
                  <div key={index}>
                    {thumbnailPreviews[index] && (
                      <div className="w-full h-24 rounded-lg mb-2 border border-border bg-card/40 flex items-center justify-center overflow-hidden p-2">
                        <img
                          src={thumbnailPreviews[index]}
                          alt={`Thumbnail ${index + 1}`}
                          className="w-full h-full object-contain"
                        />
                      </div>
                    )}
                    <ActisInput
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => handleThumbnailChange(e, index)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3 pt-4 border-t border-border">
              <ActisButton
                variant="primary"
                onClick={handleSave}
                className="flex-1"
                disabled={saving}
              >
                {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
              </ActisButton>

              {editingId && (
                <>
                  {isPublished ? (
                    <ActisButton
                      variant="secondary"
                      onClick={handleUnpublish}
                      disabled={publishing}
                    >
                      {publishing ? '...' : 'Unpublish'}
                    </ActisButton>
                  ) : (
                    <ActisButton
                      variant="accent"
                      onClick={handlePublish}
                      disabled={publishing}
                    >
                      {publishing ? '...' : 'Publish'}
                    </ActisButton>
                  )}

                  <ActisButton variant="danger" onClick={() => handleDelete(editingId)}>
                    <Trash2 size={14} />
                    Delete
                  </ActisButton>
                </>
              )}
            </div>
          </div>
        </ActisCard>
      </div>
    </div>
  );
}