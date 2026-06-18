import { createContext, useContext, useReducer, useEffect } from 'react';
import { api } from '@/services/api';

const AppContext = createContext(undefined);

const initialState = {
  isAuthenticated: false,
  user: null,
  branches: [],
  loading: true,
};

// --- Reducer ---

function appReducer(state, action) {
  switch (action.type) {
    case 'SET_AUTH':
      return { ...state, isAuthenticated: true, user: action.payload };

    case 'LOGOUT':
      // localStorage (not sessionStorage) so the token is shared across same-origin tabs — a preview
      // popup opened via window.open inherits it and can publish without a 401. The httpOnly session
      // cookie set on login is the primary auth; this is the cross-origin-dev Bearer fallback.
      localStorage.removeItem('actis_token');
      api.logout?.();  // best-effort: clear the server-side httpOnly cookie
      return { ...initialState, loading: false };

    case 'INIT_DATA':
      return { ...state, branches: action.payload, loading: false };

    case 'SET_LOADING':
      return { ...state, loading: action.payload };

    case 'SET_BRANCHES':
      return { ...state, branches: action.payload };

    default:
      return state;
  }
}

// --- Provider ---

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Load data on mount if token exists
  useEffect(() => {
    const token = localStorage.getItem('actis_token');
    if (token) {
      api
        .getBranchesTree()
        .then((branches) => {
          dispatch({ type: 'SET_AUTH', payload: { email: '' } });
          dispatch({ type: 'INIT_DATA', payload: branches });
        })
        .catch(() => {
          dispatch({ type: 'LOGOUT' });
        });
    } else {
      dispatch({ type: 'SET_LOADING', payload: false });
    }
  }, []);

  const login = async (email, password) => {
    const { token, user } = await api.login(email, password);
    localStorage.setItem('actis_token', token);
    dispatch({ type: 'SET_AUTH', payload: user });
    const branches = await api.getBranchesTree();
    dispatch({ type: 'INIT_DATA', payload: branches });
  };

  const logout = () => dispatch({ type: 'LOGOUT' });

  const refreshTree = async () => {
    const branches = await api.getBranchesTree();
    dispatch({ type: 'SET_BRANCHES', payload: branches });
  };

  // --- Branches ---
  const addBranch = async (name) => {
    await api.createBranch(name);
    await refreshTree();
  };

  const editBranch = async (branchId, name) => {
    await api.updateBranch(branchId, name);
    await refreshTree();
  };

  const deleteBranch = async (branchId) => {
    await api.deleteBranch(branchId);
    await refreshTree();
  };

  // --- Displays ---
  const addDisplay = async (branchId, name) => {
    await api.createDisplay(branchId, name);
    await refreshTree();
  };

  const editDisplay = async (branchId, displayId, name) => {
    await api.updateDisplay(displayId, name);
    await refreshTree();
  };

  const deleteDisplay = async (branchId, displayId) => {
    await api.deleteDisplay(displayId);
    await refreshTree();
  };

  // --- Case Studies ---
  const addCaseStudy = async (displayId, data) => {
    const created = await api.createCaseStudy(displayId, {
      category: data.category || '',
      title: data.title,
      bullet_points: data.bulletPoints || [],
    });
    await refreshTree();
    return created;
  };

  const editCaseStudy = async (displayId, caseStudyId, data) => {
    await api.updateCaseStudy(caseStudyId, {
      category: data.category,
      title: data.title,
      bullet_points: data.bulletPoints,
    });
    await refreshTree();
  };

  const deleteCaseStudy = async (displayId, caseStudyId) => {
    await api.deleteCaseStudy(caseStudyId);
    await refreshTree();
  };

  // --- Image uploads ---
  const uploadThumbnails = async (caseStudyId, files) => {
    const result = await api.uploadThumbnails(caseStudyId, files);
    await refreshTree();
    return result;
  };

  const deleteThumbnail = async (caseStudyId, index) => {
    await api.deleteThumbnail(caseStudyId, index);
    await refreshTree();
  };

  const publishCaseStudy = async (displayId, caseStudyId) => {
    await api.publishCaseStudy(caseStudyId);
    await refreshTree();
  };

  const unpublishCaseStudy = async (displayId, caseStudyId) => {
    await api.unpublishCaseStudy(caseStudyId);
    await refreshTree();
  };

  return (
    <AppContext.Provider
      value={{
        state,
        login,
        logout,
        addDisplay,
        editDisplay,
        deleteDisplay,
        addCaseStudy,
        editCaseStudy,
        deleteCaseStudy,
        publishCaseStudy,
        unpublishCaseStudy,
        addBranch,
        editBranch,
        deleteBranch,
        uploadThumbnails,
        deleteThumbnail,
        refreshTree,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

// Co-locating the `useApp` hook with its provider is the standard Context pattern; this is a
// dev-only Fast Refresh hint with no production impact.
// eslint-disable-next-line react-refresh/only-export-components
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
