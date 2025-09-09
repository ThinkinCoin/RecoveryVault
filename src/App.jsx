import { Routes, Route, Navigate } from "react-router-dom";
import Recovery from "@/pages/Recovery";
import AdminDash from "@/pages/AdminDash";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Recovery />} />
      <Route path="/admin" element={<AdminDash />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
