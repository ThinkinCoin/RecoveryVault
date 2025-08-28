// src/App.jsx
import React, { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Recovery from "@/pages/Recovery";
import AdminDash from "@/pages/AdminDash";
import { preloadProofs } from "@/services/whitelistService";

export default function App() {
  useEffect(() => {
    // roda uma vez ao montar o App
    preloadProofs().catch(() => {});
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Recovery />} />
      <Route path="/admin" element={<AdminDash />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
