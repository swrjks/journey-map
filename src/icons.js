import {
  createIcons, Activity, ArrowRight, Box, ChartColumn, ChartSpline, Check, ChevronDown, ChevronRight, ChevronUp, CircleCheck,
  Clock, CloudUpload, Cpu, Crosshair, Database, Download, DraftingCompass, Eraser, FileImage, FileText, FolderOpen,
  Globe, Layers, LocateFixed, Map as MapIcon, Minus, Mountain, MountainSnow, Orbit, PanelLeft, Plane, Play, Plus,
  Rotate3d, Ruler, Satellite, Scan, Search, Settings, Sparkles, Spline, SquareTerminal, TrendingUp, Upload, Waves,
  Workflow, X, Timer, Route, Grid3x3, Info, Radar, CloudRain, Flame, Wind, RotateCcw, Pause,
} from 'lucide';

const icons = {
  Activity, ArrowRight, Box, ChartColumn, ChartSpline, Check, ChevronDown, ChevronRight, ChevronUp, CircleCheck, Clock,
  CloudUpload, Cpu, Crosshair, Database, Download, DraftingCompass, Eraser, FileImage, FileText, FolderOpen, Globe,
  Layers, LocateFixed, Map: MapIcon, Minus, Mountain, MountainSnow, Orbit, PanelLeft, Plane, Play, Plus, Rotate3d, Ruler,
  Satellite, Scan, Search, Settings, Sparkles, Spline, SquareTerminal, TrendingUp, Upload, Waves, Workflow, X, Timer, Route,
  Grid3x3, Info, Radar, CloudRain, Flame, Wind, RotateCcw, Pause,
};

export function refreshIcons() {
  createIcons({ icons });
}
