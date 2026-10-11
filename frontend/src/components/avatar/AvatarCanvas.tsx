'use client';
// 3D teacher: React Three Fiber scene that loads a VRM and applies the
// procedural pose from AvatarPoseDriver every frame. Loaded client-side only
// (see TeacherAvatarPanel's dynamic import).
import { Component, ReactNode, useEffect, useRef, useState } from 'react';
import { Box3, Vector3 } from 'three';
import type { Object3D } from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { AvatarPoseDriver, AvatarPose, AvatarState } from '@/lib/avatar/avatar-state';
import { MouthWeights } from '@/lib/avatar/lip-sync';
import { ARM_AXIS } from '@/lib/avatar/config';

export type AvatarLoadStatus = 'loading' | 'ready' | 'error';

interface SceneProps {
  url: string;
  state: AvatarState;
  getMouth: () => MouthWeights;
  onStatus: (s: AvatarLoadStatus, detail?: string) => void;
  onProgress?: (fraction: number) => void;
}

const Teacher = ({ url, state, getMouth, onStatus, onProgress }: SceneProps) => {
  const vrmRef = useRef<VRM | null>(null);
  const [scene, setScene] = useState<Object3D | null>(null);   // re-render once the model is in
  const flipRef = useRef(1);       // VRM 0.x models need X/Z rotation signs mirrored (they are authored facing -Z)
  const { camera } = useThree();
  const driver = useRef(new AvatarPoseDriver());
  const stateRef = useRef(state);
  const mouthRef = useRef(getMouth);
  stateRef.current = state;
  mouthRef.current = getMouth;

  useEffect(() => {
    let cancelled = false;
    onStatus('loading');
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (cancelled) { if (vrm) VRMUtils.deepDispose(vrm.scene); return; }
        if (!vrm) { onStatus('error', 'File is not a VRM model'); return; }
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        if (vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
        vrm.scene.traverse((o) => { o.frustumCulled = false; });
        vrmRef.current = vrm;
        flipRef.current = vrm.meta?.metaVersion === '0' ? -1 : 1;
        // Frame head + upper body from the model's real size, so any VRM fits the stage.
        const box = new Box3().setFromObject(vrm.scene);
        const size = box.getSize(new Vector3());
        const centerY = box.min.y + size.y * 0.74;
        const coverage = size.y * 0.52;                                   // vertical metres to show
        const fovRad = (24 * Math.PI) / 180;
        const dist = coverage / 2 / Math.tan(fovRad / 2);
        camera.position.set(0, centerY + 0.04, dist);
        camera.lookAt(0, centerY, 0);
        setScene(vrm.scene);
        onStatus('ready');
      },
      (e) => { if (e.total > 0) onProgress?.(e.loaded / e.total); },
      (err) => { if (!cancelled) onStatus('error', (err as Error)?.message ?? 'Model failed to load'); },
    );
    return () => {
      cancelled = true;
      const vrm = vrmRef.current;
      vrmRef.current = null;
      if (vrm) VRMUtils.deepDispose(vrm.scene);   // free geometries, textures, materials
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useFrame((_, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;
    const pose = driver.current.update(delta, stateRef.current, mouthRef.current());
    applyPose(vrm, pose, flipRef.current);
    vrm.update(delta);
  });

  return scene ? <primitive object={scene} /> : null;
};

const applyPose = (vrm: VRM, p: AvatarPose, f: number) => {
  const h = vrm.humanoid;
  const bone = (n: Parameters<typeof h.getNormalizedBoneNode>[0]) => h.getNormalizedBoneNode(n);

  const spine = bone('spine'), chest = bone('chest');
  if (spine) spine.rotation.set(f * p.spine.pitch * 0.6, p.spine.yaw * 0.6, f * p.spine.roll * 0.6);
  if (chest) chest.rotation.set(f * p.spine.pitch * 0.4, p.spine.yaw * 0.4, f * p.spine.roll * 0.4);

  const neck = bone('neck'), head = bone('head');
  if (neck) neck.rotation.set(f * p.head.pitch * 0.35, p.head.yaw * 0.4, f * p.head.roll * 0.4);
  if (head) head.rotation.set(f * p.head.pitch * 0.65, p.head.yaw * 0.6, f * p.head.roll * 0.6);

  const arm = (side: 'left' | 'right') => {
    const a = side === 'left' ? p.leftArm : p.rightArm;
    const upper = bone(side === 'left' ? 'leftUpperArm' : 'rightUpperArm');
    const lower = bone(side === 'left' ? 'leftLowerArm' : 'rightLowerArm');
    const hand  = bone(side === 'left' ? 'leftHand' : 'rightHand');
    const lowerSign = side === 'left' ? ARM_AXIS.lowerSignLeft : ARM_AXIS.lowerSignRight;
    const elbowSign = side === 'left' ? ARM_AXIS.elbowSignLeft : ARM_AXIS.elbowSignRight;
    const wristSign = side === 'left' ? ARM_AXIS.wristSignLeft : ARM_AXIS.wristSignRight;
    if (upper) upper.rotation.set(f * a.forward * ARM_AXIS.forwardSign, 0, f * a.down * lowerSign);
    if (lower) lower.rotation.set(0, a.elbow * elbowSign, 0);
    if (hand)  hand.rotation.set(0, 0, f * a.wrist * wristSign);
  };
  arm('left');
  arm('right');

  const ls = bone('leftShoulder'), rs = bone('rightShoulder');
  if (ls) ls.rotation.set(0, 0, f * p.shoulderLift);
  if (rs) rs.rotation.set(0, 0, f * -p.shoulderLift);

  const ex = vrm.expressionManager;
  if (ex) {
    ex.setValue('blink', p.expr.blink);
    ex.setValue('happy', p.expr.happy);
    ex.setValue('relaxed', p.expr.relaxed);
    ex.setValue('lookUp', p.expr.lookUp);
    ex.setValue('aa', p.mouth.aa);
    ex.setValue('ih', p.mouth.ih);
    ex.setValue('ou', p.mouth.ou);
    ex.setValue('ee', p.mouth.ee);
    ex.setValue('oh', p.mouth.oh);
  }
};

// A WebGL/context failure inside Canvas must not take the chat page down.
class CanvasBoundary extends Component<{ onError: (m: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: Error) { this.props.onError(err?.message ?? 'Rendering failed'); }
  render() { return this.state.failed ? null : this.props.children; }
}

export interface AvatarCanvasProps extends SceneProps {
  className?: string;
}

export default function AvatarCanvas({ url, state, getMouth, onStatus, onProgress, className }: AvatarCanvasProps) {
  return (
    <div className={className} style={{ width: '100%', height: '100%' }}>
      <CanvasBoundary onError={(m) => onStatus('error', m)}>
        <Canvas
          dpr={[1, 1.5]}
          camera={{ position: [0, 1.26, 2.0], fov: 24, near: 0.1, far: 20 }}
          gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
          onCreated={({ camera }) => { camera.lookAt(0, 1.2, 0); }}
        >
          <ambientLight intensity={1.15} />
          <directionalLight position={[1.2, 2.2, 2]} intensity={1.4} />
          <directionalLight position={[-1.5, 1.2, 1]} intensity={0.5} />
          <Teacher url={url} state={state} getMouth={getMouth} onStatus={onStatus} onProgress={onProgress} />
        </Canvas>
      </CanvasBoundary>
    </div>
  );
}
