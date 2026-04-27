import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProvider } from "./context/AppContext";
import { ProtectedRoute } from "./routes/ProtectedRoute";
import { AdminLayout } from "./components/layout/AdminLayout";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DisplaysPage } from "./pages/DisplaysPage";
import { CaseStudyEditorPage } from "./pages/CaseStudyEditorPage";
import { DisplayViewerPage } from "./pages/DisplayViewerPage";
import { BranchesPage } from "./pages/BranchesPage";
import { AmbientDisplaysPage } from "./pages/AmbientDisplaysPage";
import { AmbientViewerPage } from "./pages/AmbientViewerPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner position="top-right" />
      <AppProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/admin/login" replace />} />
            <Route path="/admin/login" element={<LoginPage />} />
            <Route path="/branch/:id" element={<DisplayViewerPage />} />
            <Route path="/ambient/:id" element={<AmbientViewerPage />} />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <AdminLayout />
                </ProtectedRoute>
              }
            >
              <Route path="dashboard" element={<DashboardPage />} />
              <Route path="branches" element={<BranchesPage />} />
              <Route path="displays" element={<DisplaysPage />} />
              <Route path="ambient" element={<AmbientDisplaysPage />} />
              <Route path="displays/:id/editor" element={<CaseStudyEditorPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
