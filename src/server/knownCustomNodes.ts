/**
 * Known custom-node provisioning registry.
 *
 * A small, deterministic node-type -> package/repo/model-dir/pip map that lets
 * the migration pipeline auto-resolve third-party custom nodes WITHOUT asking the
 * human for a GitHub URL. It exists because the only automatic source-identification
 * paths otherwise are (a) a local install already present, (b) an explicit
 * `repository` column the Step-01 agent happened to fill in, or (c) a >=80-score
 * GitHub provider search -- all of which miss for packages like
 * `ComfyUI-llama-cpp_vlm` whose node types (`llama_cpp_*`) carry no package hint.
 *
 * This is intentionally NOT a recipe under `recipes/` (those are schema-validated
 * by `loadAllRecipes` and describe XPU *runtime* behavior). This registry answers
 * a different question: "which repo provides this node type, where do its models
 * go, and how is its pip dependency installed." Recipes stay the advisory
 * runtime-knowledge layer; this is the deterministic provisioning layer.
 *
 * Consumed by:
 *  - intakePreflight.ts (inferPackageHint)  -> Step 00 marks the node "source known"
 *  - assetAcquisition.ts (resolveCustomNodeSource) -> deterministic auto-clone
 *  - assetAcquisition.ts (targetSubdir/assetKind) -> route the node's models to modelSubdir
 *  - Step 05 skill                          -> install the right pip backend, skip CUDA reqs
 */

export interface KnownCustomNodePip {
  /** Which llama.cpp / native backend the installed binary must be built for. */
  backend: "cpu";
  /**
   * When true, the node's own requirements.txt must NOT be `pip install -r`'d
   * (e.g. it pins CUDA/Metal wheels wrong for this XPU/CPU box); install the
   * backend-appropriate wheel instead. Step 05 honors this.
   */
  skipRequirementsTxt: true;
  /** Human-readable rationale surfaced in prompts/skills. */
  note: string;
}

export interface KnownCustomNode {
  /** Canonical package / custom_nodes dir name. */
  packageName: string;
  /** Git repo cloned into `<nfs>/custom_nodes/<name>` and symlinked into the run. */
  repository: string;
  /**
   * Node `class_type` prefixes provided by this package. A workflow node whose
   * type starts with any of these belongs to this package. Prefix (not exact)
   * match keeps a single entry covering a whole node family
   * (e.g. `llama_cpp_model_loader` / `llama_cpp_parameters` / `llama_cpp_instruct_adv`).
   */
  nodeTypePrefixes: string[];
  /**
   * ComfyUI `models/<modelSubdir>/` folder this node loads its weights from
   * (e.g. `LLM` for llama.cpp GGUF + mmproj). Used to route acquired assets so a
   * human never has to hand-place them.
   */
  modelSubdir?: string;
  /** Pip dependency handling for this package (backend-specific). */
  pip?: KnownCustomNodePip;
}

/**
 * The registry. Add an entry per known third-party package the agent should
 * auto-handle end-to-end.
 */
export const KNOWN_CUSTOM_NODES: KnownCustomNode[] = [
  {
    // One of the most common ComfyUI packages (video I/O). The `VHS_` class_type
    // prefix is unambiguous — always ComfyUI-VideoHelperSuite — even when a
    // workflow bundle re-registers the nodes under its own module (which defeats
    // object_info-based attribution). Pure-python (opencv/imageio-ffmpeg), no XPU
    // patch needed; no model weights → no modelSubdir.
    packageName: "ComfyUI-VideoHelperSuite",
    repository: "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite",
    nodeTypePrefixes: ["VHS_"],
  },
  {
    packageName: "ComfyUI-llama-cpp_vlm",
    repository: "https://github.com/lihaoyun6/ComfyUI-llama-cpp_vlm",
    nodeTypePrefixes: ["llama_cpp_"],
    modelSubdir: "LLM",
    pip: {
      backend: "cpu",
      skipRequirementsTxt: true,
      note:
        "requirements.txt pins CUDA (+cu128) / Metal llama-cpp-python wheels that are wrong " +
        "for this Intel XPU/CPU box. Install the CPU-built llama-cpp-python wheel instead " +
        "(the VLM runs on CPU via llama.cpp -- n_gpu_layers is a no-op without a SYCL build -- " +
        "which uses host RAM, not XPU VRAM, leaving the XPU free for fp8 diffusion).",
    },
  },
  // ── Batch-imported from custom_node_list (XPU-validated via /object_info) ──
  {
    packageName: "ComfyUI-KJNodes",
    repository: "https://github.com/kijai/ComfyUI-KJNodes",
    nodeTypePrefixes: ["AddLabel","AddNoiseToTrackPath","AppendInstanceDiffusionTracking","AppendStringsToList","ApplyRifleXRoPE_","AudioConcatenate","BOOLConstant","BatchCLIPSeg","BatchCropFromMask","BatchCropFromMaskAdvanced","BatchUncrop","BatchUncropAdvanced","BboxToInt","BboxVisualize","BlockifyMask","CFGZeroStarAndInit","CameraPoseVisualizer","CheckpointLoaderKJ","CheckpointPerturbWeights","ColorMatch","ColorMatchV2","ColorToMask","CondPassThrough","ConditioningMultiCombine","ConditioningSetMaskAndCombine","ConditioningSetMaskAndCombine3","ConditioningSetMaskAndCombine4","ConditioningSetMaskAndCombine5","ConsolidateMasksKJ","CreateAudioMask","CreateFadeMask","CreateFadeMaskAdvanced","CreateFluidMask","CreateGradientFromCoords","CreateGradientMask","CreateInstanceDiffusionTracking","CreateMagicMask","CreateShapeImageOnPath","CreateShapeMask","CreateShapeMaskOnPath","CreateTextMask","CreateTextOnPath","CreateVoronoiMask","CrossFadeImages","CrossFadeImagesMulti","CustomControlNetWeightsFluxFromList","CustomSigmas","CutAndDragOnPath","DecodeAndSaveVideo","DiTBlockLoraLoader","DifferentialDiffusionAdvanced","DiffusionModelLoaderKJ","DiffusionModelSelector","DownloadAndLoadCLIPSeg","DrawInstanceDiffusionTracking","DrawMaskOnImage","DummyOut","EmptyLatentImageCustomPresets","EmptyLatentImagePresets","EncodeVideoComponents","EndRecordCUDAMemoryHistory","FastPreview","FilterZeroMasksAndCorrespondingImages","FlipSigmasAdjusted","FloatConstant","FloatToMask","FloatToSigmas","FluxBlockLoraSelect","GGUFLoaderKJ","GLIGENTextBoxApplyBatchCoords","GenerateNoise","GetImageRangeFromBatch","GetImageSizeAndCount","GetImagesFromBatchIndexed","GetLatentRangeFromBatch","GetLatentSizeAndCount","GetLatentsFromBatchIndexed","GetMaskSizeAndCount","GetTrackRange","GradientToFloat","GrowMaskWithBlur","HunyuanVideoBlockLoraSelect","HunyuanVideoEncodeKeyframesToCond","INTConstant","ImageAddMulti","ImageAndMaskPreview","ImageBatchExtendWithOverlap","ImageBatchFilter","ImageBatchJoinWithTransition","ImageBatchMulti","ImageBatchRepeatInterleaving","ImageBatchTestPattern","ImageConcanate","ImageConcatFromBatch","ImageConcatMulti","ImageCropByMask","ImageCropByMaskAndResize","ImageCropByMaskBatch","ImageGrabPIL","ImageGridComposite2x2","ImageGridComposite3x3","ImageGridtoBatch","ImageNoiseAugmentation","ImageNormalize_Neg1_To_1","ImagePadForOutpaintMasked","ImagePadForOutpaintTargetSize","ImagePadKJ","ImagePass","ImagePrepForICLora","ImageResizeKJ","ImageResizeKJv2","ImageSharpenKJ","ImageTensorList","ImageTransformByNormalizedAmplitude","ImageTransformKJ","ImageUncropByMask","ImageUpscaleWithModelBatched","InjectNoiseToLatent","InsertImageBatchByIndexes","InsertImagesToBatchIndexed","InsertLatentToIndexed","InterpolateCoords","Intrinsic_lora_sampling","JoinStringMulti","JoinStrings","LTX2AttentionTunerPatch","LTX2AudioLatentNormalizingSampling","LTX2BlockLoraSelect","LTX2LoraLoaderAdvanced","LTX2MemoryEfficientSageAttentionPatch","LTX2SamplingPreviewOverride","LTX2_NAG","LTXVAddGuideMulti","LTXVAddGuidesFromBatch","LTXVAudioVideoMask","LTXVChunkFeedForward","LTXVEnhanceAVideoKJ","LTXVImgToVideoInplaceKJ","LatentInpaintTTM","LazySwitchKJ","LeapfusionHunyuanI2VPatcher","LoadAndResizeImage","LoadImagesFromFolderKJ","LoadResAdapterNormalization","LoadVideosFromFolder","LoraExtractKJ","LoraReduceRankKJ","MaskBatchMulti","MaskOrImageToWeight","MergeImageChannels","ModelMemoryUsageFactorOverride","ModelMemoryUseReportPatch","ModelPassThrough","ModelPatchTorchSettings","ModelSaveKJ","NABLA_AttentionKJ","NormalizedAmplitudeToFloatList","NormalizedAmplitudeToMask","OffsetMask","OffsetMaskByNormalizedAmplitude","PadImageBatchInterleaved","PatchModelPatcherOrder","PathchSageAttentionKJ","PlaySoundKJ","PlotCoordinates","PointsEditor","PreviewAnimation","PreviewImageOrMask","PreviewLatentNoiseMask","RemapImageRange","RemapMaskRange","ReplaceImagesInBatch","ResizeMask","ReverseImageBatch","RoundMask","SV3D_BatchSchedule","SamplerSelfRefineVideo","SaveImageKJ","SaveImageWithAlpha","SaveStringKJ","ScaleBatchPromptSchedule","ScheduledCFGGuidance","ScreencapStream","Screencap_mss","SeparateMasks","SetShakkerLabsUnionControlNetType","ShuffleImageBatch","SigmasToFloat","SimpleCalculatorKJ","SkipLayerGuidanceWanVideo","Sleep","SomethingToString","SoundReactive","SplineEditor","SplitBboxes","SplitImageChannels","StableZero123_BatchSchedule","StartRecordCUDAMemoryHistory","StringConstant","StringConstantMultiline","StringToFloatList","StyleModelApplyAdvanced","Superprompt","TimerNodeKJ","TorchCompileControlNet","TorchCompileCosmosModel","TorchCompileLTXModel","TorchCompileModelAdvanced","TorchCompileModelFluxAdvanced","TorchCompileModelFluxAdvancedV2","TorchCompileModelHyVideo","TorchCompileModelQwenImage","TorchCompileModelWanVideo","TorchCompileModelWanVideoV2","TorchCompileVAE","TransitionImagesInBatch","TransitionImagesMulti","VAEDecodeLoopKJ","VAELoaderKJ","VRAM_Debug","VisualizeCUDAMemoryHistory","VisualizeSigmasKJ","Wan21BlockLoraSelect","WanChunkFeedForward","WanImageToVideoSVIPro","WanVideoEnhanceAVideoKJ","WanVideoNAG","WanVideoTeaCacheKJ","WebcamCaptureCV2","WeightScheduleConvert","WeightScheduleExtend","WidgetToString"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "rgthree-comfy",
    repository: "https://github.com/rgthree/rgthree-comfy",
    nodeTypePrefixes: ["Any Switch (rgthree)","Context (rgthree)","Context Big (rgthree)","Context Merge (rgthree)","Context Merge Big (rgthree)","Context Switch (rgthree)","Context Switch Big (rgthree)","Display Any (rgthree)","Display Int (rgthree)","Image Comparer (rgthree)","Image Inset Crop (rgthree)","Image Resize (rgthree)","Image or Latent Size (rgthree)","KSampler Config (rgthree)","Lora Loader Stack (rgthree)","Power Lora Loader (rgthree)","Power Primitive (rgthree)","Power Prompt (rgthree)","Power Prompt - Simple (rgthree)","Power Puter (rgthree)","SDXL Empty Latent Image (rgthree)","SDXL Power Prompt - Positive (rgthree)","SDXL Power Prompt - Simple / Negative (rgthree)","Seed (rgthree)"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-Easy-Use",
    repository: "https://github.com/yolain/ComfyUI-Easy-Use",
    nodeTypePrefixes: ["dynamicThresholdingFull","easy LLLiteLoader","easy XYInputs: CFG Scale","easy XYInputs: Checkpoint","easy XYInputs: ControlNet","easy XYInputs: Denoise","easy XYInputs: FluxGuidance","easy XYInputs: Lora","easy XYInputs: ModelMergeBlocks","easy XYInputs: NegativeCond","easy XYInputs: NegativeCondList","easy XYInputs: PositiveCond","easy XYInputs: PositiveCondList","easy XYInputs: PromptSR","easy XYInputs: Sampler/Scheduler","easy XYInputs: Seeds++ Batch","easy XYInputs: Steps","easy XYPlot","easy XYPlotAdvanced","easy a1111Loader","easy ab","easy anythingIndexSwitch","easy anythingInversedSwitch","easy applyBrushNet","easy applyFooocusInpaint","easy applyInpaint","easy applyPowerPaint","easy batchAnything","easy blocker","easy boolean","easy cascadeKSampler","easy cascadeLoader","easy ckptNames","easy cleanGpuUsed","easy clearCacheAll","easy clearCacheKey","easy comfyLoader","easy compare","easy conditioningIndexSwitch","easy controlnetLoader","easy controlnetLoader++","easy controlnetLoaderADV","easy controlnetNames","easy controlnetStack","easy controlnetStackApply","easy convertAnything","easy detailerFix","easy float","easy fluxLoader","easy forLoopEnd","easy forLoopStart","easy fullCascadeKSampler","easy fullLoader","easy fullkSampler","easy globalSeed","easy hiresFix","easy humanSegmentation","easy hunyuanDiTLoader","easy icLightApply","easy if","easy ifElse","easy imageBatchToImageList","easy imageChooser","easy imageColorMatch","easy imageConcat","easy imageCount","easy imageCropFromMask","easy imageDetailTransfer","easy imageIndexSwitch","easy imageInsetCrop","easy imageInterrogator","easy imageListToImageBatch","easy imagePixelPerfect","easy imageRatio","easy imageRemBg","easy imageSave","easy imageScaleDown","easy imageScaleDownBy","easy imageScaleDownToSize","easy imageScaleToNormPixels","easy imageSize","easy imageSizeByLongerSide","easy imageSizeBySide","easy imageSplitGrid","easy imageSplitList","easy imageSplitTiles","easy imageSwitch","easy imageTilesFromBatch","easy imageToBase64","easy imageToMask","easy imageUncropFromBBOX","easy imagesCountInDirectory","easy imagesSplitImage","easy indexAnything","easy injectNoiseToLatent","easy instantIDApply","easy instantIDApplyADV","easy int","easy ipadapterApply","easy ipadapterApplyADV","easy ipadapterApplyEmbeds","easy ipadapterApplyEncoder","easy ipadapterApplyFaceIDKolors","easy ipadapterApplyFromParams","easy ipadapterApplyRegional","easy ipadapterStyleComposition","easy isFileExist","easy isMaskEmpty","easy isNone","easy isSDXL","easy joinImageBatch","easy joyCaption2API","easy joyCaption3API","easy kSampler","easy kSamplerCustom","easy kSamplerDownscaleUnet","easy kSamplerInpainting","easy kSamplerLayerDiffusion","easy kSamplerSDTurbo","easy kSamplerTiled","easy kolorsLoader","easy latentCompositeMaskedWithCond","easy latentNoisy","easy lengthAnything","easy loadImageBase64","easy loadImagesForLoop","easy loraNames","easy loraPromptApply","easy loraStack","easy loraStackApply","easy loraSwitcher","easy makeImageForICLora","easy mathFloat","easy mathInt","easy mathString","easy mochiLoader","easy multiAngle","easy negative","easy outputToList","easy pipeBatchIndex","easy pipeEdit","easy pipeEditPrompt","easy pipeIn","easy pipeOut","easy pipeToBasicPipe","easy pixArtLoader","easy pixels","easy portraitMaster","easy poseEditor","easy positive","easy preDetailerFix","easy preMaskDetailerFix","easy preSampling","easy preSamplingAdvanced","easy preSamplingCascade","easy preSamplingCustom","easy preSamplingDynamicCFG","easy preSamplingLayerDiffusion","easy preSamplingLayerDiffusionADDTL","easy preSamplingNoiseIn","easy preSamplingSdTurbo","easy prompt","easy promptAwait","easy promptConcat","easy promptLine","easy promptList","easy promptReplace","easy pulIDApply","easy pulIDApplyADV","easy rangeFloat","easy rangeInt","easy removeLocalImage","easy samLoaderPipe","easy saveImageLazy","easy saveText","easy saveTextLazy","easy seed","easy seedList","easy showAnything","easy showAnythingLazy","easy showLoaderSettingsNames","easy showSpentTime","easy showTensorShape","easy simpleMath","easy simpleMathDual","easy sleep","easy sliderControl","easy stableDiffusion3API","easy string","easy stringJoinLines","easy stringToFloatList","easy stringToIntList","easy styleAlignedBatchAlign","easy stylesSelector","easy sv3dLoader","easy svdLoader","easy tableEditor","easy textIndexSwitch","easy textSwitch","easy ultralyticsDetectorPipe","easy unSampler","easy whileLoopEnd","easy whileLoopStart","easy wildcards","easy wildcardsMatrix","easy xyAny","easy zero123Loader"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI_essentials",
    repository: "https://github.com/cubiq/ComfyUI_essentials",
    nodeTypePrefixes: ["ApplyCLIPSeg+","BatchCount+","CLIPTextEncodeSDXL+","ConditioningCombineMultiple+","ConsoleDebug+","DebugTensorShape+","DisplayAny","DrawText+","FluxAttentionSeeker+","FluxBlocksBuster+","FluxSamplerParams+","GetImageSize+","GuidanceTimestepping+","ImageApplyLUT+","ImageBatchMultiple+","ImageBatchToList+","ImageCASharpening+","ImageColorMatch+","ImageColorMatchAdobe+","ImageComposite+","ImageCompositeFromMaskBatch+","ImageCrop+","ImageDesaturate+","ImageEnhanceDifference+","ImageExpandBatch+","ImageFlip+","ImageFromBatch+","ImageHistogramMatch+","ImageListToBatch+","ImagePosterize+","ImagePreviewFromLatent+","ImageRandomTransform+","ImageRemoveAlpha+","ImageRemoveBackground+","ImageResize+","ImageSeamCarving+","ImageSmartSharpen+","ImageTile+","ImageToDevice+","ImageUntile+","InjectLatentNoise+","KSamplerVariationsStochastic+","KSamplerVariationsWithNoise+","LoadCLIPSegModels+","LorasForFluxParams+","MaskBatch+","MaskBlur+","MaskBoundingBox+","MaskExpandBatch+","MaskFix+","MaskFlip+","MaskFromBatch+","MaskFromColor+","MaskFromList+","MaskFromRGBCMYBW+","MaskFromSegmentation+","MaskPreview+","MaskSmooth+","ModelCompile+","ModelSamplingSD3Advanced+","NoiseFromImage+","PixelOEPixelize+","PlotParameters+","RemBGSession+","RemoveLatentMask+","SD3AttentionSeekerLG+","SD3AttentionSeekerT5+","SD3NegativeConditioning+","SDXLEmptyLatentSizePicker+","SamplerSelectHelper+","SchedulerSelectHelper+","SimpleComparison+","SimpleCondition+","SimpleMath+","SimpleMathBoolean+","SimpleMathCondition+","SimpleMathDual+","SimpleMathFloat+","SimpleMathInt+","SimpleMathPercent+","SimpleMathSlider+","SimpleMathSliderLowRes+","TextEncodeForSamplerParams+","TransitionMask+","TransparentBGSession+"],
  },
  {
    packageName: "ComfyUI-Custom-Scripts",
    repository: "https://github.com/pythongosssss/ComfyUI-Custom-Scripts",
    nodeTypePrefixes: ["CheckpointLoader|pysssss","ConstrainImageforVideo|pysssss","ConstrainImage|pysssss","LoadText|pysssss","LoraLoader|pysssss","MathExpression|pysssss","PlaySound|pysssss","Repeater|pysssss","ReroutePrimitive|pysssss","SaveText|pysssss","ShowText|pysssss","StringFunction|pysssss","SystemNotification|pysssss"],
  },
  {
    packageName: "comfyui_controlnet_aux",
    repository: "https://github.com/Fannovel16/comfyui_controlnet_aux/",
    nodeTypePrefixes: ["AIO_Preprocessor","AnimalPosePreprocessor","AnimeFace_SemSegPreprocessor","AnimeLineArtPreprocessor","AnyLineArtPreprocessor_aux","BAE-NormalMapPreprocessor","BinaryPreprocessor","CannyEdgePreprocessor","ColorPreprocessor","ControlNetAuxSimpleAddText","ControlNetPreprocessorSelector","DSINE-NormalMapPreprocessor","DWPreprocessor","DensePosePreprocessor","DepthAnythingPreprocessor","DepthAnythingV2Preprocessor","DiffusionEdge_Preprocessor","ExecuteAllControlNetPreprocessors","FacialPartColoringFromPoseKps","FakeScribblePreprocessor","HEDPreprocessor","HintImageEnchance","ImageGenResolutionFromImage","ImageGenResolutionFromLatent","ImageIntensityDetector","ImageLuminanceDetector","InpaintPreprocessor","LeReS-DepthMapPreprocessor","LineArtPreprocessor","LineartStandardPreprocessor","M-LSDPreprocessor","Manga2Anime_LineArt_Preprocessor","MaskOptFlow","MediaPipe-FaceMeshPreprocessor","MeshGraphormer+ImpactDetector-DepthMapPreprocessor","MeshGraphormer-DepthMapPreprocessor","Metric3D-DepthMapPreprocessor","Metric3D-NormalMapPreprocessor","MiDaS-DepthMapPreprocessor","MiDaS-NormalMapPreprocessor","OneFormer-ADE20K-SemSegPreprocessor","OneFormer-COCO-SemSegPreprocessor","OpenposePreprocessor","PiDiNetPreprocessor","PixelPerfectResolution","PyraCannyPreprocessor","RenderAnimalKps","RenderPeopleKps","SAMPreprocessor","SavePoseKpsAsJsonFile","ScribblePreprocessor","Scribble_","SemSegPreprocessor","ShufflePreprocessor","TEEDPreprocessor","TTPlanet_","TilePreprocessor","UniFormer-SemSegPreprocessor","Unimatch_OptFlowPreprocessor","UpperBodyTrackingFromPoseKps","Zoe-DepthMapPreprocessor","Zoe_DepthAnythingPreprocessor"],
  },
  {
    packageName: "ComfyUI-GGUF",
    repository: "https://github.com/city96/ComfyUI-GGUF",
    nodeTypePrefixes: ["CLIPLoaderGGUF","DualCLIPLoaderGGUF","QuadrupleCLIPLoaderGGUF","TripleCLIPLoaderGGUF","UnetLoaderGGUF","UnetLoaderGGUFAdvanced"],
  },
  {
    packageName: "ComfyUI-Impact-Subpack",
    repository: "https://github.com/ltdrdata/ComfyUI-Impact-Subpack",
    nodeTypePrefixes: ["UltralyticsDetectorProvider"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI_LayerStyle",
    repository: "https://github.com/chflame163/ComfyUI_LayerStyle",
    nodeTypePrefixes: ["LayerColor: AutoAdjust","LayerColor: AutoAdjustV2","LayerColor: AutoBrightness","LayerColor: Brightness & Contrast","LayerColor: BrightnessContrastV2","LayerColor: Color of Shadow & Highlight","LayerColor: ColorAdapter","LayerColor: ColorBalance","LayerColor: ColorTemperature","LayerColor: ColorofShadowHighlightV2","LayerColor: Exposure","LayerColor: Gamma","LayerColor: HSV","LayerColor: LAB","LayerColor: LUT Apply","LayerColor: Levels","LayerColor: Negative","LayerColor: RGB","LayerColor: YUV","LayerFilter: AddGrain","LayerFilter: ChannelShake","LayerFilter: ColorMap","LayerFilter: DistortDisplace","LayerFilter: Film","LayerFilter: FilmV2","LayerFilter: GaussianBlur","LayerFilter: GaussianBlurV2","LayerFilter: HDREffects","LayerFilter: HalfTone","LayerFilter: LightLeak","LayerFilter: MotionBlur","LayerFilter: Sharp & Soft","LayerFilter: SkinBeauty","LayerFilter: SoftLight","LayerFilter: WaterColor","LayerMask: BlendIf Mask","LayerMask: CreateGradientMask","LayerMask: DrawRoundedRectangle","LayerMask: ImageToMask","LayerMask: LoadSegformerModel","LayerMask: MaskBoxDetect","LayerMask: MaskBoxExtend","LayerMask: MaskByColor","LayerMask: MaskEdgeShrink","LayerMask: MaskEdgeUltraDetail","LayerMask: MaskEdgeUltraDetail V2","LayerMask: MaskEdgeUltraDetail V3","LayerMask: MaskGradient","LayerMask: MaskGrain","LayerMask: MaskGrow","LayerMask: MaskInvert","LayerMask: MaskMotionBlur","LayerMask: MaskPreview","LayerMask: MaskStroke","LayerMask: PixelSpread","LayerMask: RemBgUltra","LayerMask: RmBgUltra V2","LayerMask: SegformerB2ClothesUltra","LayerMask: SegformerClothesPipelineLoader","LayerMask: SegformerClothesSetting","LayerMask: SegformerFashionPipelineLoader","LayerMask: SegformerFashionSetting","LayerMask: SegformerUltraV2","LayerMask: SegformerUltraV3","LayerMask: Shadow & Highlight Mask","LayerMask: ShadowHighlightMaskV2","LayerStyle: ColorOverlay","LayerStyle: ColorOverlay V2","LayerStyle: DropShadow","LayerStyle: DropShadow V2","LayerStyle: DropShadow V3","LayerStyle: Gradient Map","LayerStyle: GradientOverlay","LayerStyle: GradientOverlay V2","LayerStyle: InnerGlow","LayerStyle: InnerGlow V2","LayerStyle: InnerShadow","LayerStyle: InnerShadow V2","LayerStyle: OuterGlow","LayerStyle: OuterGlow V2","LayerStyle: Stroke","LayerStyle: Stroke V2","LayerUtility: AnyRerouter","LayerUtility: BatchSelector","LayerUtility: Boolean","LayerUtility: BooleanOperator","LayerUtility: BooleanOperatorV2","LayerUtility: CheckMask","LayerUtility: CheckMaskV2","LayerUtility: ChoiceTextPreset","LayerUtility: ColorImage","LayerUtility: ColorImage V2","LayerUtility: ColorName","LayerUtility: ColorPicker","LayerUtility: CropBoxResolve","LayerUtility: CropByMask","LayerUtility: CropByMask V2","LayerUtility: CropByMask V3","LayerUtility: ExtendCanvas","LayerUtility: ExtendCanvasV2","LayerUtility: Float","LayerUtility: FluxKontextImageScale","LayerUtility: GetImageSize","LayerUtility: GetMainColors","LayerUtility: GetMainColorsV2","LayerUtility: GradientImage","LayerUtility: GradientImage V2","LayerUtility: GrayValue","LayerUtility: HLFrequencyDetailRestore","LayerUtility: HSV Value","LayerUtility: ICMask","LayerUtility: ICMaskCropBack","LayerUtility: If ","LayerUtility: ImageBatchToList","LayerUtility: ImageBlend","LayerUtility: ImageBlend V2","LayerUtility: ImageBlendAdvance","LayerUtility: ImageBlendAdvance V2","LayerUtility: ImageBlendAdvance V3","LayerUtility: ImageChannelMerge","LayerUtility: ImageChannelSplit","LayerUtility: ImageCombineAlpha","LayerUtility: ImageCompositeHandleMask","LayerUtility: ImageHub","LayerUtility: ImageListToBatch","LayerUtility: ImageMaskScaleAs","LayerUtility: ImageMaskScaleAsV2","LayerUtility: ImageOpacity","LayerUtility: ImageReel","LayerUtility: ImageReelComposit","LayerUtility: ImageRemoveAlpha","LayerUtility: ImageScaleByAspectRatio","LayerUtility: ImageScaleByAspectRatio V2","LayerUtility: ImageScaleRestore","LayerUtility: ImageScaleRestore V2","LayerUtility: ImageShift","LayerUtility: ImageTaggerSave","LayerUtility: ImageTaggerSaveV2","LayerUtility: Integer","LayerUtility: LayerImageTransform","LayerUtility: LayerMaskTransform","LayerUtility: LoadImagesFromPath","LayerUtility: LoadVQAModel","LayerUtility: NameToColor","LayerUtility: NanoBananaImageScale","LayerUtility: NumberCalculator","LayerUtility: NumberCalculatorV2","LayerUtility: PrintInfo","LayerUtility: PurgeVRAM","LayerUtility: PurgeVRAM V2","LayerUtility: QueueStop","LayerUtility: RGB Value","LayerUtility: RandomGenerator","LayerUtility: RandomGeneratorV2","LayerUtility: RestoreCropBox","LayerUtility: RoundedRectangle","LayerUtility: Seed","LayerUtility: SimpleTextImage","LayerUtility: String","LayerUtility: StringCondition","LayerUtility: SwitchCase","LayerUtility: TextBox","LayerUtility: TextImage","LayerUtility: TextImage V2","LayerUtility: TextJoin","LayerUtility: TextJoinV2","LayerUtility: TextPreseter","LayerUtility: VQAPrompt","LayerUtility: XY to Percent"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "cg-use-everywhere",
    repository: "https://github.com/chrisgoringe/cg-use-everywhere",
    nodeTypePrefixes: ["Anything Everywhere","Anything Everywhere3","Anything Everywhere?","Combo Clone","Prompts Everywhere","Seed Everywhere","Simple String"],
  },
  {
    packageName: "ComfyUI-WanVideoWrapper",
    repository: "https://github.com/kijai/ComfyUI-WanVideoWrapper",
    nodeTypePrefixes: ["CreateCFGScheduleFloatList","CreateScheduleFloatList","DownloadAndLoadNLFModel","DownloadAndLoadWav2VecModel","DrawArcFaceLandmarks","DrawGaussianNoiseOnImage","DrawNLFPoses","DummyComfyWanModelObject","ExtractStartFramesForContinuations","FaceMaskFromPoseKeypoints","FantasyPortraitFaceDetector","FantasyPortraitModelLoader","FantasyTalkingModelLoader","FantasyTalkingWav2VecEmbeds","HuMoEmbeds","LandmarksToImage","LoadLynxResampler","LoadNLFModel","LoadVQVAE","LoadWanVideoClipTextEncoder","LoadWanVideoT5TextEncoder","LongCatAvatarWhisperEmbeds","LynxEncodeFaceIP","LynxInsightFaceCrop","MTVCrafterEncodePoses","MochaEmbeds","MultiTalkModelLoader","MultiTalkSilentEmbeds","MultiTalkWav2VecEmbeds","NLFPredict","NormalizeAudioLoudness","OviMMAudioVAELoader","QwenLoader","ReCamMasterPoseVisualizer","TextImageEncodeQwenVL","WanMove_native","WanVideoATITracks","WanVideoATITracksVisualize","WanVideoATI_comfy","WanVideoAddBindweaveEmbeds","WanVideoAddControlEmbeds","WanVideoAddDualControlEmbeds","WanVideoAddExtraLatent","WanVideoAddFantasyPortrait","WanVideoAddFlashVSRInput","WanVideoAddLucyEditLatents","WanVideoAddLynxEmbeds","WanVideoAddMTVMotion","WanVideoAddOneToAllExtendEmbeds","WanVideoAddOneToAllPoseEmbeds","WanVideoAddOneToAllReferenceEmbeds","WanVideoAddOviAudioToLatents","WanVideoAddPusaNoise","WanVideoAddS2VEmbeds","WanVideoAddSCAILPoseEmbeds","WanVideoAddSCAILReferenceEmbeds","WanVideoAddStandInLatent","WanVideoAddSteadyDancerEmbeds","WanVideoAddStoryMemLatents","WanVideoAddTTMLatents","WanVideoAddWanMoveTracks","WanVideoAnimateEmbeds","WanVideoApplyNAG","WanVideoBlockList","WanVideoBlockSwap","WanVideoClipVisionEncode","WanVideoCombineEmbeds","WanVideoContextOptions","WanVideoControlEmbeds","WanVideoControlnet","WanVideoControlnetLoader","WanVideoDecode","WanVideoDecodeOviAudio","WanVideoDiffusionForcingSampler","WanVideoEasyCache","WanVideoEmptyEmbeds","WanVideoEmptyMMAudioLatents","WanVideoEncode","WanVideoEncodeLatentBatch","WanVideoEncodeOviAudio","WanVideoEnhanceAVideo","WanVideoExperimentalArgs","WanVideoExtraModelSelect","WanVideoFlashVSRDecoderLoader","WanVideoFreeInitArgs","WanVideoFunCameraEmbeds","WanVideoImageClipEncode","WanVideoImageResizeToClosest","WanVideoImageToVideoEncode","WanVideoImageToVideoMultiTalk","WanVideoImageToVideoSkyreelsv3_audio","WanVideoLatentReScale","WanVideoLongCatAvatarExtendEmbeds","WanVideoLoopArgs","WanVideoLoraBlockEdit","WanVideoLoraSelect","WanVideoLoraSelectByName","WanVideoLoraSelectMulti","WanVideoMagCache","WanVideoMiniMaxRemoverEmbeds","WanVideoModelLoader","WanVideoOviCFG","WanVideoPassImagesFromSamples","WanVideoPhantomEmbeds","WanVideoPreviewEmbeds","WanVideoPromptExtender","WanVideoPromptExtenderSelect","WanVideoReCamMasterCameraEmbed","WanVideoReCamMasterDefaultCamera","WanVideoReCamMasterGenerateOrbitCamera","WanVideoRealisDanceLatents","WanVideoRoPEFunction","WanVideoSLG","WanVideoSVIProEmbeds","WanVideoSampler","WanVideoSamplerExtraArgs","WanVideoSamplerFromSettings","WanVideoSamplerSettings","WanVideoSamplerv2","WanVideoScheduler","WanVideoSchedulerv2","WanVideoSetAttentionModeOverride","WanVideoSetBlockSwap","WanVideoSetLoRAs","WanVideoSetRadialAttention","WanVideoSigmaToStep","WanVideoTeaCache","WanVideoTextEmbedBridge","WanVideoTextEncode","WanVideoTextEncodeCached","WanVideoTextEncodeSingle","WanVideoTinyVAELoader","WanVideoTorchCompileSettings","WanVideoUltraVicoSettings","WanVideoUni3C_","WanVideoUniAnimateDWPoseDetector","WanVideoUniAnimatePoseInput","WanVideoUniLumosEmbeds","WanVideoVACEEncode","WanVideoVACEModelSelect","WanVideoVACEStartToEndFrame","WanVideoVAELoader","WanVideoVRAMManagement","WanVideoWanDrawWanMoveTracks","Wav2VecModelLoader","WhisperModelLoader"],
  },
  {
    packageName: "ComfyUI-Frame-Interpolation",
    repository: "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation",
    nodeTypePrefixes: ["AMT VFI","ATM VFI","CAIN VFI","FILM VFI","FLAVR VFI","GMFSS Fortuna VFI","IFRNet VFI","IFUnet VFI","KSampler Gradually Adding More Denoise (efficient)","M2M VFI","MOMO VFI","Make Interpolation State List","RIFE VFI","STMFNet VFI","Sepconv VFI","VFI FloatToInt"],
  },
  {
    packageName: "ComfyUI_UltimateSDUpscale",
    repository: "https://github.com/ssitu/ComfyUI_UltimateSDUpscale",
    nodeTypePrefixes: ["UltimateSDUpscale","UltimateSDUpscaleCustomSample","UltimateSDUpscaleGuider","UltimateSDUpscaleNoUpscale"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-Florence2",
    repository: "https://github.com/kijai/ComfyUI-Florence2",
    nodeTypePrefixes: ["DownloadAndLoadFlorence2Lora","DownloadAndLoadFlorence2Model","Florence2ModelLoader","Florence2Run"],
  },
  {
    packageName: "ComfyUI_IPAdapter_plus",
    repository: "https://github.com/cubiq/ComfyUI_IPAdapter_plus",
    nodeTypePrefixes: ["IPAAdapterFaceIDBatch","IPAdapter","IPAdapterAdvanced","IPAdapterBatch","IPAdapterClipVisionEnhancer","IPAdapterClipVisionEnhancerBatch","IPAdapterCombineEmbeds","IPAdapterCombineParams","IPAdapterCombineWeights","IPAdapterEmbeds","IPAdapterEmbedsBatch","IPAdapterEncoder","IPAdapterFaceID","IPAdapterFaceIDKolors","IPAdapterFromParams","IPAdapterInsightFaceLoader","IPAdapterLoadEmbeds","IPAdapterMS","IPAdapterModelLoader","IPAdapterNoise","IPAdapterPreciseComposition","IPAdapterPreciseCompositionBatch","IPAdapterPreciseStyleTransfer","IPAdapterPreciseStyleTransferBatch","IPAdapterPromptScheduleFromWeightsStrategy","IPAdapterRegionalConditioning","IPAdapterSaveEmbeds","IPAdapterStyleComposition","IPAdapterStyleCompositionBatch","IPAdapterTiled","IPAdapterTiledBatch","IPAdapterUnifiedLoader","IPAdapterUnifiedLoaderCommunity","IPAdapterUnifiedLoaderFaceID","IPAdapterWeights","IPAdapterWeightsFromStrategy","PrepImageForClipVision"],
  },
  {
    packageName: "was-node-suite-comfyui",
    repository: "https://github.com/ltdrdata/was-node-suite-comfyui",
    nodeTypePrefixes: ["BLIP Analyze Image","BLIP Model Loader","Blend Latents","Boolean To Text","Bounded Image Blend","Bounded Image Blend with Mask","Bounded Image Crop","Bounded Image Crop with Mask","Bus Node","CLIP Input Switch","CLIP Vision Input Switch","CLIPSEG2","CLIPSeg Batch Masking","CLIPSeg Masking","CLIPSeg Model Loader","CLIPTextEncode (NSP)","Cache Node","Checkpoint Loader","Checkpoint Loader (Simple)","Conditioning Input Switch","Constant Number","Control Net Model Input Switch","Convert Masks to Images","Create Grid Image","Create Grid Image from Batch","Create Morph Image","Create Morph Image from Path","Create Video from Path","Debug Number to Console","Dictionary to Console","Diffusers Hub Model Down-Loader","Diffusers Model Loader","Export API","HSL to Hex","Hex to HSL","Image Analyze","Image Aspect Ratio","Image Batch","Image Blank","Image Blend","Image Blend by Mask","Image Blending Mode","Image Bloom Filter","Image Bounds","Image Bounds to Console","Image Canny Filter","Image Chromatic Aberration","Image Color Palette","Image Crop Face","Image Crop Location","Image Crop Square Location","Image Displacement Warp","Image Dragan Photography Filter","Image Edge Detection Filter","Image Film Grain","Image Filter Adjustments","Image Flip","Image Generate Gradient","Image Gradient Map","Image High Pass Filter","Image History Loader","Image Input Switch","Image Levels Adjustment","Image Load","Image Lucy Sharpen","Image Median Filter","Image Mix RGB Channels","Image Monitor Effects Filter","Image Nova Filter","Image Padding","Image Paste Crop","Image Paste Crop by Location","Image Paste Face","Image Perlin Noise","Image Perlin Power Fractal","Image Pixelate","Image Power Noise","Image Rembg (Remove Background)","Image Remove Background (Alpha)","Image Remove Color","Image Resize","Image Rotate","Image Rotate Hue","Image SSAO (Ambient Occlusion)","Image SSDO (Direct Occlusion)","Image Save","Image Seamless Texture","Image Select Channel","Image Select Color","Image Send HTTP","Image Shadows and Highlights","Image Size to Number","Image Stitch","Image Style Filter","Image Threshold","Image Tiled","Image Transpose","Image Voronoi Noise Filter","Image fDOF Filter","Image to Latent Mask","Image to Noise","Image to Seed","Images to Linear","Images to RGB","Inset Image Bounds","Integer place counter","KSampler (WAS)","KSampler Cycle","Latent Batch","Latent Input Switch","Latent Noise Injection","Latent Size to Number","Latent Upscale by Factor (WAS)","Load Cache","Load Image Batch","Load Lora","Load Text File","Logic Boolean","Logic Boolean Primitive","Logic Comparison AND","Logic Comparison OR","Logic Comparison XOR","Logic NOT","Lora Input Switch","Lora Loader","Mask Arbitrary Region","Mask Batch","Mask Batch to Mask","Mask Ceiling Region","Mask Crop Dominant Region","Mask Crop Minority Region","Mask Crop Region","Mask Dilate Region","Mask Dominant Region","Mask Erode Region","Mask Fill Holes","Mask Floor Region","Mask Gaussian Region","Mask Invert","Mask Minority Region","Mask Paste Region","Mask Rect Area","Mask Rect Area (Advanced)","Mask Smooth Region","Mask Threshold Region","Masks Add","Masks Combine Batch","Masks Combine Regions","Masks Subtract","MiDaS Depth Approximation","MiDaS Mask Image","MiDaS Model Loader","Model Input Switch","Number Counter","Number Input Condition","Number Input Switch","Number Multiple Of","Number Operation","Number PI","Number to Float","Number to Int","Number to Seed","Number to String","Number to Text","Prompt Multiple Styles Selector","Prompt Styles Selector","Random Number","SAM Image Mask","SAM Model Loader","SAM Parameters","SAM Parameters Combine","Samples Passthrough (Stat System)","Save Text File","Seed","String to Text","Tensor Batch to Image","Text Add Token by Input","Text Add Tokens","Text Compare","Text Concatenate","Text Contains","Text Dictionary Convert","Text Dictionary Get","Text Dictionary Keys","Text Dictionary New","Text Dictionary To Text","Text Dictionary Update","Text File History Loader","Text Find","Text Find and Replace","Text Find and Replace Input","Text Find and Replace by Dictionary","Text Input Switch","Text List","Text List Concatenate","Text List to Text","Text Load Line From File","Text Multiline","Text Multiline (Code Compatible)","Text Parse A1111 Embeddings","Text Parse Noodle Soup Prompts","Text Parse Tokens","Text Random Line","Text Random Prompt","Text Shuffle","Text Sort","Text String","Text String Truncate","Text to Conditioning","Text to Console","Text to Number","Text to String","True Random.org Number Generator","Upscale Model Loader","Upscale Model Switch","VAE Input Switch","Video Dump Frames","Write to GIF","Write to Video","unCLIP Checkpoint Loader"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "was-node-suite-comfyui",
    repository: "https://github.com/WASasquatch/was-node-suite-comfyui",
    nodeTypePrefixes: ["BLIP Analyze Image","BLIP Model Loader","Blend Latents","Boolean To Text","Bounded Image Blend","Bounded Image Blend with Mask","Bounded Image Crop","Bounded Image Crop with Mask","Bus Node","CLIP Input Switch","CLIP Vision Input Switch","CLIPSEG2","CLIPSeg Batch Masking","CLIPSeg Masking","CLIPSeg Model Loader","CLIPTextEncode (NSP)","Cache Node","Checkpoint Loader","Checkpoint Loader (Simple)","Conditioning Input Switch","Constant Number","Control Net Model Input Switch","Convert Masks to Images","Create Grid Image","Create Grid Image from Batch","Create Morph Image","Create Morph Image from Path","Create Video from Path","Debug Number to Console","Dictionary to Console","Diffusers Hub Model Down-Loader","Diffusers Model Loader","Export API","HSL to Hex","Hex to HSL","Image Analyze","Image Aspect Ratio","Image Batch","Image Blank","Image Blend","Image Blend by Mask","Image Blending Mode","Image Bloom Filter","Image Bounds","Image Bounds to Console","Image Canny Filter","Image Chromatic Aberration","Image Color Palette","Image Crop Face","Image Crop Location","Image Crop Square Location","Image Displacement Warp","Image Dragan Photography Filter","Image Edge Detection Filter","Image Film Grain","Image Filter Adjustments","Image Flip","Image Generate Gradient","Image Gradient Map","Image High Pass Filter","Image History Loader","Image Input Switch","Image Levels Adjustment","Image Load","Image Lucy Sharpen","Image Median Filter","Image Mix RGB Channels","Image Monitor Effects Filter","Image Nova Filter","Image Padding","Image Paste Crop","Image Paste Crop by Location","Image Paste Face","Image Perlin Noise","Image Perlin Power Fractal","Image Pixelate","Image Power Noise","Image Rembg (Remove Background)","Image Remove Background (Alpha)","Image Remove Color","Image Resize","Image Rotate","Image Rotate Hue","Image SSAO (Ambient Occlusion)","Image SSDO (Direct Occlusion)","Image Save","Image Seamless Texture","Image Select Channel","Image Select Color","Image Send HTTP","Image Shadows and Highlights","Image Size to Number","Image Stitch","Image Style Filter","Image Threshold","Image Tiled","Image Transpose","Image Voronoi Noise Filter","Image fDOF Filter","Image to Latent Mask","Image to Noise","Image to Seed","Images to Linear","Images to RGB","Inset Image Bounds","Integer place counter","KSampler (WAS)","KSampler Cycle","Latent Batch","Latent Input Switch","Latent Noise Injection","Latent Size to Number","Latent Upscale by Factor (WAS)","Load Cache","Load Image Batch","Load Lora","Load Text File","Logic Boolean","Logic Boolean Primitive","Logic Comparison AND","Logic Comparison OR","Logic Comparison XOR","Logic NOT","Lora Input Switch","Lora Loader","Mask Arbitrary Region","Mask Batch","Mask Batch to Mask","Mask Ceiling Region","Mask Crop Dominant Region","Mask Crop Minority Region","Mask Crop Region","Mask Dilate Region","Mask Dominant Region","Mask Erode Region","Mask Fill Holes","Mask Floor Region","Mask Gaussian Region","Mask Invert","Mask Minority Region","Mask Paste Region","Mask Rect Area","Mask Rect Area (Advanced)","Mask Smooth Region","Mask Threshold Region","Masks Add","Masks Combine Batch","Masks Combine Regions","Masks Subtract","MiDaS Depth Approximation","MiDaS Mask Image","MiDaS Model Loader","Model Input Switch","Number Counter","Number Input Condition","Number Input Switch","Number Multiple Of","Number Operation","Number PI","Number to Float","Number to Int","Number to Seed","Number to String","Number to Text","Prompt Multiple Styles Selector","Prompt Styles Selector","Random Number","SAM Image Mask","SAM Model Loader","SAM Parameters","SAM Parameters Combine","Samples Passthrough (Stat System)","Save Text File","Seed","String to Text","Tensor Batch to Image","Text Add Token by Input","Text Add Tokens","Text Compare","Text Concatenate","Text Contains","Text Dictionary Convert","Text Dictionary Get","Text Dictionary Keys","Text Dictionary New","Text Dictionary To Text","Text Dictionary Update","Text File History Loader","Text Find","Text Find and Replace","Text Find and Replace Input","Text Find and Replace by Dictionary","Text Input Switch","Text List","Text List Concatenate","Text List to Text","Text Load Line From File","Text Multiline","Text Multiline (Code Compatible)","Text Parse A1111 Embeddings","Text Parse Noodle Soup Prompts","Text Parse Tokens","Text Random Line","Text Random Prompt","Text Shuffle","Text Sort","Text String","Text String Truncate","Text to Conditioning","Text to Console","Text to Number","Text to String","True Random.org Number Generator","Upscale Model Loader","Upscale Model Switch","VAE Input Switch","Video Dump Frames","Write to GIF","Write to Video","unCLIP Checkpoint Loader"],
  },
  {
    packageName: "efficiency-nodes-comfyui",
    repository: "https://github.com/jags111/efficiency-nodes-comfyui",
    nodeTypePrefixes: ["Apply ControlNet Stack","Control Net Stacker","Eff. Loader SDXL","Efficient Loader","Evaluate Floats","Evaluate Integers","Evaluate Strings","HighRes-Fix Script","Image Overlay","Join XY Inputs of Same Type","KSampler (Efficient)","KSampler Adv. (Efficient)","KSampler SDXL (Eff.)","LoRA Stack to String converter","LoRA Stacker","Manual XY Entry Info","Noise Control Script","Pack SDXL Tuple","Simple Eval Examples","Tiled Upscaler Script","Unpack SDXL Tuple","XY Input: Add/Return Noise","XY Input: Aesthetic Score","XY Input: CFG Scale","XY Input: Checkpoint","XY Input: Clip Skip","XY Input: Control Net","XY Input: Control Net Plot","XY Input: Denoise","XY Input: LoRA","XY Input: LoRA Plot","XY Input: LoRA Stacks","XY Input: Manual XY Entry","XY Input: Prompt S/R","XY Input: Refiner On/Off","XY Input: Sampler/Scheduler","XY Input: Seeds++ Batch","XY Input: Steps","XY Input: VAE","XY Plot"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-mxToolkit",
    repository: "https://github.com/Smirnov75/ComfyUI-mxToolkit",
    nodeTypePrefixes: ["mxSeed","mxSlider","mxSlider2D","mxStop"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "comfy_mtb",
    repository: "https://github.com/melMass/comfy_mtb",
    nodeTypePrefixes: ["Add To Playlist (mtb)","Animation Builder (mtb)","Any To String (mtb)","Apply Text Template (mtb)","Apply Vit Matte (mtb)","Audio Cut (mtb)","Audio Duration (mtb)","Audio Isolate Speaker (mtb)","Audio Resample (mtb)","Audio Sequence (mtb)","Audio Stack (mtb)","Audio To Text (mtb)","Auto Pan Equilateral (mtb)","BBox Force Dimensions (mtb)","Batch Float (mtb)","Batch Float Assemble (mtb)","Batch Float Fill (mtb)","Batch Float Fit (mtb)","Batch Float Math (mtb)","Batch Float Normalize (mtb)","Batch From Folder (mtb)","Batch Make (mtb)","Batch Merge (mtb)","Batch Sequence (mtb)","Batch Sequence Plus (mtb)","Batch Shake (mtb)","Batch Shape (mtb)","Batch Time Wrap (mtb)","Batch2d Transform (mtb)","Bbox (mtb)","Bbox From Mask (mtb)","Blur (mtb)","Boolean Not (mtb)","Color Correct (mtb)","Color Correct GPU (mtb)","Color Input (mtb)","Colored Image (mtb)","Concat Images (mtb)","Coordinates To String (mtb)","Crop (mtb)","Curve (mtb)","Curve To Float (mtb)","Debug (mtb)","Deep Bump (mtb)","End Clock (mtb)","Export With Ffmpeg (mtb)","Extract Coordinates From Image (mtb)","Face Swap (mtb)","Filter Z (mtb)","Fit Number (mtb)","Float To Floats (mtb)","Float To Number (mtb)","Floats To Float (mtb)","Floats To Ints (mtb)","Generate Trimap (mtb)","Get Batch From History (mtb)","Get Item (mtb)","Image Batch To Sublist (mtb)","Image Compare (mtb)","Image H264 Compression (mtb)","Image Premultiply (mtb)","Image Remove Background Rembg (mtb)","Image Resize Factor (mtb)","Image Tile Offset (mtb)","Int To Bool (mtb)","Int To Number (mtb)","Interpolate Clip Sequential (mtb)","Interpolate Condition (mtb)","Latent Lerp (mtb)","Load Face Analysis Model (mtb)","Load Face Enhance Model (mtb)","Load Face Swap Model (mtb)","Load Image From Url (mtb)","Load Image Sequence (mtb)","Load Vit Matte Model (mtb)","Load Whisper (mtb)","Mask To Image (mtb)","Match Dimensions (mtb)","Math Expression (mtb)","Model Patch Seamless (mtb)","Model Pruner (mtb)","Pick From Batch (mtb)","Plot Batch Float (mtb)","Postshot Export (mtb)","Postshot Train (mtb)","Process Whisper Diarization (mtb)","Process Whisper Output (mtb)","Qr Code (mtb)","Read Playlist (mtb)","Restore Face (mtb)","Save Gif (mtb)","Save Image (mtb)","Save Image Grid (mtb)","Save Image Sequence (mtb)","Save Tensors (mtb)","Sharpen (mtb)","Smart Step (mtb)","Split Bbox (mtb)","Stack Images (mtb)","Start Clock (mtb)","String Replace (mtb)","Styles Loader (mtb)","Sublist To Image Batch (mtb)","Tensor Ops (mtb)","Text To Image (mtb)","To Device (mtb)","Transform Image (mtb)","Uncrop (mtb)","Unsplash Image (mtb)","Upscale Bbox By (mtb)","Vae Decode (mtb)"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "gguf",
    repository: "https://github.com/calcuis/gguf",
    nodeTypePrefixes: ["AudioEncoderLoaderGGUF","ClipLoaderGGUF","DualClipLoaderGGUF","GGUFRun","GGUFSave","GGUFUndo","LoaderGGUF","LoaderGGUFAdvanced","QuadrupleClipLoaderGGUF","TENSORBoost","TENSORCut","TripleClipLoaderGGUF","VaeGGUF"],
  },
  {
    packageName: "ComfyUI-ReActor",
    repository: "https://github.com/Gourieff/ComfyUI-ReActor",
    nodeTypePrefixes: ["ImageRGBA2RGB","ReActorBuildFaceModel","ReActorFaceBoost","ReActorFaceSimilarity","ReActorFaceSwap","ReActorFaceSwapOpt","ReActorImageDublicator","ReActorLoadFaceModel","ReActorMakeFaceModelBatch","ReActorMaskHelper","ReActorOptions","ReActorRestoreFace","ReActorRestoreFaceAdvanced","ReActorSaveFaceModel","ReActorSetWeight","ReActorUnload"],
  },
  {
    packageName: "comfyui-art-venture",
    repository: "https://github.com/sipherxyz/comfyui-art-venture",
    nodeTypePrefixes: ["AV_","AspectRatioSelector","BLIPCaption","BLIPLoader","BooleanPrimitive","CheckpointNameSelector","ColorBlend","ColorCorrect","DeepDanbooruCaption","DependenciesEdit","DownloadAndLoadBlip","DownloadISNetModel","Fooocus_","GetBoolFromJson","GetFloatFromJson","GetIntFromJson","GetObjectFromJson","GetSAMEmbedding","GetTextFromJson","ISNetLoader","ISNetSegment","ImageAlphaComposite","ImageApplyChannel","ImageExtractChannel","ImageGaussianBlur","ImageMuxer","ImageRepeat","ImageScaleDown","ImageScaleDownBy","ImageScaleDownToSize","ImageScaleToMegapixels","LaMaInpaint","LoadImageAsMaskFromUrl","LoadImageFromUrl","LoadJsonFromText","LoadJsonFromUrl","LoadLaMaModel","MergeModels","NumberScaler","OverlayInpaintedImage","OverlayInpaintedLatent","PrepareImageAndMaskForInpaint","QRCodeGenerator","RandomFloat","RandomInt","SAMEmbeddingToImage","SDXLAspectRatioSelector","SDXLPromptStyler","SeedSelector","StringToInt","StringToNumber","TextRandomMultiline","TextSwitchCase"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-Inpaint-CropAndStitch",
    repository: "https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch",
    nodeTypePrefixes: ["InpaintCropImproved","InpaintStitchImproved"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-RMBG",
    repository: "https://github.com/1038lab/ComfyUI-RMBG",
    nodeTypePrefixes: ["AILab_","BiRefNetRMBG","BodySegment","ClothesSegment","FaceSegment","FashionSegmentAccessories","FashionSegmentClothing","RMBG","SAM2Segment","Segment","SegmentV2"],
  },
  {
    packageName: "ComfyUI-MultiGPU",
    repository: "https://github.com/pollockjj/ComfyUI-MultiGPU",
    nodeTypePrefixes: ["CLIPLoaderDisTorch2MultiGPU","CLIPLoaderMultiGPU","CLIPVisionLoaderDisTorch2MultiGPU","CLIPVisionLoaderMultiGPU","CheckpointLoaderAdvancedDisTorch2MultiGPU","CheckpointLoaderAdvancedMultiGPU","CheckpointLoaderSimpleDisTorch2MultiGPU","CheckpointLoaderSimpleMultiGPU","ControlNetLoaderDisTorch2MultiGPU","ControlNetLoaderMultiGPU","DeviceSelectorMultiGPU","DiffControlNetLoaderDisTorch2MultiGPU","DiffControlNetLoaderMultiGPU","DiffusersLoaderDisTorch2MultiGPU","DiffusersLoaderMultiGPU","DualCLIPLoaderDisTorch2MultiGPU","DualCLIPLoaderMultiGPU","LTXVLoaderMultiGPU","MMAudioFeatureUtilsLoaderMultiGPU","MMAudioModelLoaderMultiGPU","MMAudioSamplerMultiGPU","QuadrupleCLIPLoaderDisTorch2MultiGPU","QuadrupleCLIPLoaderMultiGPU","TripleCLIPLoaderDisTorch2MultiGPU","TripleCLIPLoaderMultiGPU","UNETLoaderDisTorch2MultiGPU","UNETLoaderMultiGPU","UNetLoaderLP","VAELoaderDisTorch2MultiGPU","VAELoaderMultiGPU"],
  },
  {
    packageName: "ComfyUI-SeedVR2_VideoUpscaler",
    repository: "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler",
    nodeTypePrefixes: ["SeedVR2LoadDiTModel","SeedVR2LoadVAEModel","SeedVR2TorchCompileSettings","SeedVR2VideoUpscaler"],
  },
  {
    packageName: "ComfyUI-Detail-Daemon",
    repository: "https://github.com/Jonseed/ComfyUI-Detail-Daemon",
    nodeTypePrefixes: ["DetailDaemonGraphSigmasNode","DetailDaemonSamplerGUINode","DetailDaemonSamplerNode","LyingSigmaSampler","MultiplySigmas"],
  },
  {
    packageName: "ComfyUI-LogicUtils",
    repository: "https://github.com/aria1th/ComfyUI-LogicUtils",
    nodeTypePrefixes: ["AbsNode","AddNode","Base64DecodeNode","Base64EncodeNode","Base64ToStringNode","BrightnessNode","CeilNode","CensorImageByRating","ColorNode","ComposeRGBAImageFromMask","ConcatGridNode","ConcatTwoImagesNode","ContrastNode","ConvertAny2Boolean","ConvertAny2Dict","ConvertAny2Float","ConvertAny2Int","ConvertAny2List","ConvertAny2Set","ConvertAny2String","ConvertAny2Tuple","ConvertComboToString","ConvertGreyscaleNode","ConvertRGBNode","CounterFloat","CounterInteger","CurrentTimestamp","DebugComboInputNode","DictCreateNode","DictGetNode","DictItemsNode","DictKeysNode","DictMergeNode","DictPointer","DictRemoveKeyNode","DictSetNode","DictValuesNode","DimensionSelectorWithSeedNode","DivideNode","DumpTextJsonlNode","ErrorNode","FFTNode","FilterTagsNode","FloorNode","GetAllTagsAboveThresholdNode","GetAllTagsExceptCharacterAboveThresholdNode","GetCharactersAboveThresholdFromTextNode","GetCharactersAboveThresholdNode","GetImageInfoNode","GetLengthString","GetRatingFromTextNode","GetRatingNode","GetTagsAboveThresholdFromTextNode","GetTagsAboveThresholdNode","GlobalVarGetNode","GlobalVarLoadNode","GlobalVarRemoveNode","GlobalVarSaveNode","GlobalVarSetIfNotExistsNode","GlobalVarSetNode","ImageFromURLNode","InvertImageNode","IsPrimeNode","JsonDumpAnyStructureNode","JsonDumpNode","JsonParseNode","ListAppendNode","ListCreateNode","ListExtendNode","ListGetNode","ListInsertNode","ListPopNode","ListRemoveNode","LogNode","LogicGateAnd","LogicGateBitwiseAnd","LogicGateBitwiseNot","LogicGateBitwiseOr","LogicGateBitwiseShift","LogicGateBitwiseXor","LogicGateCompare","LogicGateCompareString","LogicGateEither","LogicGateInvertBasic","LogicGateNegateValue","LogicGateOr","ManualChoiceFloat","ManualChoiceInt","ManualChoiceString","MaxNode","MemoryNode","MergeString","MinNode","ModuloNode","MultiplyNode","ParseExifNode","PowerNode","ProbabilityGate","RAMPNode","RandomGaussianFloat","RandomShuffleFloat","RandomShuffleInt","RandomShuffleString","ReplaceString","ResizeImageEnsuringMultiple","ResizeImageNode","ResizeImageResolution","ResizeImageResolutionIfBigger","ResizeImageResolutionIfSmaller","ResizeLongestToNode","ResizeScaleImageNode","ResizeShortestToNode","RotateImageNode","RoundNode","SDWebuiAPIFallbackNode","SDWebuiAPINode","SaveCustomJPGNode","SaveImageCustomNode","SaveImageWebpCustomNode","SaveTextCustomNode","SecureBase64Encrypt","SecureWebPDecrypt","SetAddNode","SetClearNode","SetCreateNode","SetDifferenceNode","SetIntersectionNode","SetRemoveNode","SetSymDifferenceNode","SetToListNode","SetUnionNode","SharpnessNode","SigmoidNode","SleepNodeAny","SleepNodeImage","StaticNumberFloat","StaticNumberInt","StaticString","StringListToCombo","StringToBase64Node","SystemRandomFloat","SystemRandomGaussianFloat","SystemRandomInt","SystemUUIDGenerator","TextPreviewNode","ThresholdNode","ToListTypeNode","ToSetTypeNode","TriangularRandomFloat","UniformRandomChoice","UniformRandomFloat","UniformRandomInt","WeightedRandomChoice","YieldableIteratorInt","YieldableIteratorString"],
  },
  {
    packageName: "Derfuu_ComfyUI_ModdedNodes",
    repository: "https://github.com/Derfuu/Derfuu_ComfyUI_ModdedNodes",
    nodeTypePrefixes: ["DF_"],
  },
  {
    packageName: "ComfyUI-Advanced-ControlNet",
    repository: "https://github.com/Kosinkadink/ComfyUI-Advanced-ControlNet",
    nodeTypePrefixes: ["ACN_","ControlNetLoaderAdvanced","CustomControlNetWeights","CustomT2IAdapterWeights","DiffControlNetLoaderAdvanced","LatentKeyframe","LatentKeyframeBatchedGroup","LatentKeyframeGroup","LatentKeyframeTiming","LoadImagesFromDirectory","ScaledSoftControlNetWeights","ScaledSoftMaskedUniversalWeights","SoftControlNetWeights","SoftT2IAdapterWeights","TimestepKeyframe"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "comfyui-mixlab-nodes",
    repository: "https://github.com/shadowcz007/comfyui-mixlab-nodes",
    nodeTypePrefixes: ["3DImage","AnalyzeAudio","AppInfo","ApplyVisualStylePrompting_","AreaToMask","AudioPlay","CenterImage","ChinesePrompt_Mix","CkptNames_","ClipInterrogator","Color","CombineAudioVideo","ComparingTwoFrames_","CompositeImages_","CreateJsonNode","DepthViewer","DynamicDelayProcessor","EditMask","EmbeddingPrompt","EnhanceImage","FaceToMask","FeatheredMask","FloatSlider","FloatingVideo","Font","GLIGENTextBoxApply_Advanced","GenerateFramesByCount","GetImageSize_","GradientImage","GridDisplayAndSave","GridInput","GridOutput","ImageBatchToList_","ImageColorTransfer","ImageCropByAlpha","ImageListReplace_","ImageListToBatch_","ImagesPrompt_","IncrementingListNode_","IntNumber","JoinWithDelimiter","KeyInput","LimitNumber","ListSplit_","LoadAndCombinedAudio_","LoadImagesFromPath","LoadImagesFromURL","LoadImagesToBatch","LoadTripoSRModel_","LoadVideoAndSegment_","LoadVideoFromURL","LoraNames_","MaskListMerge_","MaskListReplace_","MergeLayers","MiniCPM_VQA_Simple","MirroredImage","MultiplicationNode","NewLayer","NoiseImage","OutlineMask","P5Input","PreviewMask_","PromptGenerate_Mix","PromptImage","PromptSimplification","PromptSlide","RandomPrompt","RembgNode_Mix","ResizeImageMixlab","SamplerNames_","SaveImageAndMetadata_","SaveImageToLocal","SaveTripoSRMesh","ScenesNode_","ScreenShare","Seed_","ShowLayer","SmoothMask","SpeechRecognition","SpeechSynthesis","SplitImage","SplitLongMask","StyleAlignedBatchAlign_","StyleAlignedReferenceSampler_","StyleAlignedSampleReferenceLatents_","SvgImage","SwitchByIndex","TESTNODE_","TextImage","TextInput_","TextToNumber","TransparentImage","TripoSRSampler_","VAEEncodeForInpaint_Frames","VideoCombine_Adv","VideoGenKlingNode","VideoGenLumaDreamMachineNode","VideoGenRunwayGen3Node"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI_tinyterraNodes",
    repository: "https://github.com/TinyTerra/ComfyUI_tinyterraNodes",
    nodeTypePrefixes: ["ttN KSampler_v2","ttN advPlot combo","ttN advPlot images","ttN advPlot merge","ttN advPlot range","ttN advPlot string","ttN advanced xyPlot","ttN concat","ttN conditioning","ttN debugInput","ttN float","ttN hiresfixScale","ttN imageOutput","ttN imageREMBG","ttN int","ttN multiModelMerge","ttN pipe2BASIC","ttN pipe2DETAILER","ttN pipeEDIT","ttN pipeEncodeConcat","ttN pipeIN","ttN pipeKSampler","ttN pipeKSamplerAdvanced","ttN pipeKSamplerAdvanced_v2","ttN pipeKSamplerSDXL","ttN pipeKSamplerSDXL_v2","ttN pipeKSampler_v2","ttN pipeLoader","ttN pipeLoaderSDXL","ttN pipeLoaderSDXL_v2","ttN pipeLoader_v2","ttN pipeLoraStack","ttN pipeOUT","ttN seed","ttN text","ttN text3BOX_3WAYconcat","ttN text7BOX_concat","ttN textCycleLine","ttN textDebug","ttN textOutput","ttN tinyLoader","ttN xyPlot"],
  },
  {
    packageName: "ComfyUI-QwenVL",
    repository: "https://github.com/1038lab/ComfyUI-QwenVL",
    nodeTypePrefixes: ["AILab_"],
  },
  {
    packageName: "ComfyUI_LayerStyle_Advance",
    repository: "https://github.com/chflame163/ComfyUI_LayerStyle_Advance",
    nodeTypePrefixes: ["LayerMask: BBoxJoin","LayerMask: BenUltra","LayerMask: BiRefNetUltra","LayerMask: BiRefNetUltraV2","LayerMask: DrawBBoxMask","LayerMask: DrawBBoxMaskV2","LayerMask: EVFSAMUltra","LayerMask: Florence2Ultra","LayerMask: HumanPartsUltra","LayerMask: LoadBenModel","LayerMask: LoadBiRefNetModel","LayerMask: LoadBiRefNetModelV2","LayerMask: LoadFlorence2Model","LayerMask: LoadSAM2Model","LayerMask: LoadSegmentAnythingModels","LayerMask: MaskByDifferent","LayerMask: MediapipeFacialSegment","LayerMask: ObjectDetectorFL2","LayerMask: ObjectDetectorGemini","LayerMask: ObjectDetectorGeminiV2","LayerMask: ObjectDetectorMask","LayerMask: ObjectDetectorYOLO8","LayerMask: ObjectDetectorYOLOWorld","LayerMask: PersonMaskUltra","LayerMask: PersonMaskUltra V2","LayerMask: SAM2Ultra","LayerMask: SAM2UltraV2","LayerMask: SAM2VideoUltra","LayerMask: SegmentAnythingUltra","LayerMask: SegmentAnythingUltra V2","LayerMask: SegmentAnythingUltra V3","LayerMask: TransparentBackgroundUltra","LayerMask: YoloV8Detect","LayerUtility: AddBlindWaterMark","LayerUtility: Collage","LayerUtility: CreateQRCode","LayerUtility: DecodeQRCode","LayerUtility: DeepSeekAPI","LayerUtility: DeepSeekAPIV2","LayerUtility: Florence2Image2Prompt","LayerUtility: Gemini","LayerUtility: GeminiImageEdit","LayerUtility: GeminiV2","LayerUtility: GetColorTone","LayerUtility: GetColorToneV2","LayerUtility: ImageAutoCrop","LayerUtility: ImageAutoCrop V2","LayerUtility: ImageAutoCrop V3","LayerUtility: ImageRewardFilter","LayerUtility: JimengI2IAPI","LayerUtility: JoyCaption2","LayerUtility: JoyCaption2ExtraOptions","LayerUtility: JoyCaption2Split","LayerUtility: JoyCaptionBeta1","LayerUtility: JoyCaptionBeta1ExtraOptions","LayerUtility: LaMa","LayerUtility: LlamaVision","LayerUtility: LoadJoyCaption2Model","LayerUtility: LoadJoyCaptionBeta1Model","LayerUtility: LoadPSD","LayerUtility: LoadSmolLM2Model","LayerUtility: LoadSmolVLMModel","LayerUtility: PhiPrompt","LayerUtility: PromptEmbellish","LayerUtility: PromptTagger","LayerUtility: QWenImage2Prompt","LayerUtility: SD3NegativeConditioning","LayerUtility: SaveImagePlus","LayerUtility: SaveImagePlusV2","LayerUtility: ShowBlindWaterMark","LayerUtility: SmolLM2","LayerUtility: SmolVLM","LayerUtility: UserPromptGeneratorReplaceWord","LayerUtility: UserPromptGeneratorTxt2ImgPrompt","LayerUtility: UserPromptGeneratorTxt2ImgPromptWithReference","LayerUtility: ZhipuGLM4","LayerUtility: ZhipuGLM4V"],
  },
  {
    packageName: "ComfyUI-VoxCPM",
    repository: "https://github.com/wildminder/ComfyUI-VoxCPM",
    nodeTypePrefixes: ["VoxCPM_"],
  },
  {
    packageName: "ComfyUI-Hunyuan3d-2-1",
    repository: "https://github.com/visualbruno/ComfyUI-Hunyuan3d-2-1",
    nodeTypePrefixes: ["Hy3D21CameraConfig","Hy3D21ExportMesh","Hy3D21GenerateMultiViewsBatch","Hy3D21IMRemesh","Hy3D21LoadImageWithTransparency","Hy3D21LoadMesh","Hy3D21MeshGenerationBatch","Hy3D21MeshGenerator","Hy3D21MeshGenerator2","Hy3D21MeshUVWrap","Hy3D21MeshlibDecimate","Hy3D21ModelLoader","Hy3D21MultiViewsGeneratorWithMetaData","Hy3D21PostprocessMesh","Hy3D21ResizeImages","Hy3D21SimpleMeshlibDecimate","Hy3D21UseMultiViews","Hy3D21UseMultiViewsFromMetaData","Hy3D21VAEConfig","Hy3D21VAEDecode","Hy3D21VAELoader","Hy3DBakeMultiViews","Hy3DBakeMultiViewsWithMetaData","Hy3DHighPolyToLowPolyBakeMultiViewsWithMetaData","Hy3DInPaint","Hy3DMultiViewsGenerator"],
  },
  {
    packageName: "ComfyUI-HY-Motion1",
    repository: "https://github.com/jtydhr88/ComfyUI-HY-Motion1",
    nodeTypePrefixes: ["HYMotionEncodeText","HYMotionExportFBX","HYMotionExportGLB","HYMotionGenerate","HYMotionLoadLLM","HYMotionLoadLLMGGUF","HYMotionLoadNetwork","HYMotionLoadPrompter","HYMotionPreview","HYMotionPreviewAnimation","HYMotionRewritePrompt","HYMotionSaveNPZ"],
  },
  {
    packageName: "ComfyUI-CacheDiT",
    repository: "https://github.com/Jasonzzt/ComfyUI-CacheDiT",
    nodeTypePrefixes: ["CacheDiT_","WanCacheOptimizer"],
  },
  {
    packageName: "raylight",
    repository: "https://github.com/komikndr/raylight",
    nodeTypePrefixes: ["DPKSamplerAdvanced","DPNoiseList","DPSamplerCustom","RayAddNoise","RayBasicScheduler","RayBetaSamplingScheduler","RayEasyCache","RayGGUFLoader","RayInitializer","RayLoraLoader","RayModelComputeDtype","RayModelSamplingAuraFlow","RayModelSamplingContinuousEDM","RayModelSamplingContinuousV","RayModelSamplingDiscrete","RayModelSamplingFlux","RayModelSamplingSD3","RayModelSamplingStableCascade","RayRescaleCFG","RaySamplerSASolver","RaySamplingPercentToSigma","RayTeaCache","RayTorchCompileModel","RayUNETLoader","RayVAEDecodeDistributed","XFuserKSamplerAdvanced","XFuserSamplerCustom"],
  },
  {
    packageName: "ComfyUI_SenseNova_U1",
    repository: "https://github.com/smthemex/ComfyUI_SenseNova_U1",
    nodeTypePrefixes: ["SenseNova_"],
  },
  {
    packageName: "ControlAltAI-Nodes",
    repository: "https://github.com/gseth/ControlAltAI-Nodes",
    nodeTypePrefixes: ["BooleanBasic","BooleanReverse","ChooseUpscaleModel","FluxAttentionCleanup","FluxAttentionControl","FluxResolutionNode","FluxSampler","FluxUnionControlNetApply","GetImageSizeRatio","HiDreamResolutionNode","IntegerSettings","IntegerSettingsAdvanced","NoisePlusBlend","PerturbationTexture","RegionMaskConditioning","RegionMaskGenerator","RegionMaskProcessor","RegionMaskValidator","RegionOverlayVisualizer","TextBridge","ThreeWaySwitch","TwoWaySwitch"],
  },
  {
    packageName: "ComfyUI-AnimateDiff-Evolved",
    repository: "https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved",
    nodeTypePrefixes: ["ADE_","AnimateDiffLoaderV1","CheckpointLoaderSimpleWithNoiseSelect"],
  },
  {
    packageName: "ComfyUI-WD14-Tagger",
    repository: "https://github.com/pythongosssss/ComfyUI-WD14-Tagger",
    nodeTypePrefixes: ["WD14Tagger|pysssss"],
  },
  {
    packageName: "ComfyUI_Custom_Nodes_AlekPet",
    repository: "https://github.com/AlekPet/ComfyUI_Custom_Nodes_AlekPet",
    nodeTypePrefixes: ["ArgosTranslateCLIPTextEncodeNode","ArgosTranslateTextNode","ChatGLM4InstructMediaNode","ChatGLM4InstructNode","ChatGLM4TranslateCLIPTextEncodeNode","ChatGLM4TranslateTextNode","ChatGLMImageGenerateNode","ChatGLMVideoGenerateNode","ColorsCorrectNode","DeepTranslatorCLIPTextEncodeNode","DeepTranslatorTextNode","GoogleTranslateCLIPTextEncodeNode","GoogleTranslateTextNode","HexToHueNode","IDENode","PainterNode","PoseNode","PreviewTextNode"],
  },
  {
    packageName: "comfyui-inpaint-nodes",
    repository: "https://github.com/Acly/comfyui-inpaint-nodes",
    nodeTypePrefixes: ["INPAINT_"],
  },
  {
    packageName: "ComfyUI-AdvancedLivePortrait",
    repository: "https://github.com/PowerHouseMan/ComfyUI-AdvancedLivePortrait",
    nodeTypePrefixes: ["AdvancedLivePortrait","ExpData","ExpressionEditor","LoadExpData","PrintExpData:","SaveExpData"],
  },
  {
    packageName: "Comfyui-Memory_Cleanup",
    repository: "https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup",
    nodeTypePrefixes: ["RAMCleanup","VRAMCleanup"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-JakeUpgrade",
    repository: "https://github.com/jakechai/ComfyUI-JakeUpgrade",
    nodeTypePrefixes: ["Adv3DViewer_JK","Base Model Parameters SD3API JK","Bool Binary And JK","Bool Binary OR JK","CM_","CR Apply ControlNet JK","CR Apply LoRA Stack JK","CR Apply LoRA Stack Model Only JK","CR Apply Multi-ControlNet Adv JK","CR Aspect Ratio JK","CR Audio Input Switch JK","CR Boolean JK","CR Clip Input Switch JK","CR Conditioning Input Switch JK","CR ControlNet Input Switch JK","CR ControlNet Loader JK","CR ControlNet Stack Input Switch JK","CR Float Input Switch JK","CR Guider Input Switch JK","CR Image Input Switch JK","CR Impact Pipe Input Switch JK","CR Int Input Switch JK","CR Latent Input Switch JK","CR LoRA Stack JK","CR LoRA Stack Model Only JK","CR Mask Input Switch JK","CR Mesh Input Switch JK","CR Model Input Switch JK","CR Multi-ControlNet Param Stack JK","CR Noise Input Switch JK","CR Orbit Pose Input Switch JK","CR Ply Input Switch JK","CR Sampler Input Switch JK","CR Sigmas Input Switch JK","CR Text Input Switch JK","CR TriMesh Input Switch JK","CR VAE Input Switch JK","Color Grading JK","Create Loop Schedule List","Cut Audio Cuts JK","Cut Audio Index JK","Cut Audio JK","Cut Audio Loop JK","Empty Latent Color JK","Evaluate Examples JK","Evaluate Floats JK","Evaluate Ints JK","Evaluate Strings JK","Get Nth String JK","Get OrbitPoses From List JK","Get Size JK","Guidance Default JK","HintImageEnchance JK","Image Crop By Mask Resolution Grp JK","Image Crop by Mask Params JK","Image Remove Alpha JK","Image Resize Mode JK","Inject Noise Params JK","Int Sub Operation JK","Is Mask Empty JK","Ksampler Adv Parameters Default JK","Ksampler Parameters Default JK","LTXV2 Frame Count JK","Latent Crop Offset JK","Load String List From JSON JK","Make Image Grid JK","OpenDWPose_JK","Orbit Poses JK","OrbitLists to OrbitPoses JK","OrbitPoses to OrbitLists JK","Project Setting JK","Random Beats JK","RandomPrompterGeek_JK","RandomPrompter_JK","Remove Input JK","Rough Outline JK","SAM3D From Video JK","SD3 Prompts Switch JK","SDXL Target Res JK","Sampler Loader JK","Save String List To JSON JK","Scale To Resolution JK","Scene Cuts JK","ShotScriptCombiner_JK","ShotScriptExtractor_JK","Split Image Grid JK","String To Combo JK","SystemPrompter_JK","Tiling Mode JK","Upscale Method JK","Wan Frame Count JK","Wan Wrapper Sampler Default JK","Wan22 cfg Scheduler List JK"],
  },
  {
    packageName: "Comfyui_TTP_Toolset",
    repository: "https://github.com/TTPlanetPig/Comfyui_TTP_Toolset",
    nodeTypePrefixes: ["LTXVContext_TTP","LTXVFirstLastFrameControl_TTP","LTXVMiddleFrame_TTP","TTP_","TTPlanet_Tile_Preprocessor_Simple","TeaCacheHunyuanVideoSampler"],
  },
  {
    packageName: "ComfyUI-SUPIR",
    repository: "https://github.com/kijai/ComfyUI-SUPIR",
    nodeTypePrefixes: ["SUPIR_"],
  },
  {
    packageName: "ComfyUI-MelBandRoFormer",
    repository: "https://github.com/kijai/ComfyUI-MelBandRoFormer",
    nodeTypePrefixes: ["MelBandRoFormerModelLoader","MelBandRoFormerSampler"],
  },
  {
    packageName: "ComfyUI_InstantID",
    repository: "https://github.com/cubiq/ComfyUI_InstantID",
    nodeTypePrefixes: ["ApplyInstantID","ApplyInstantIDAdvanced","ApplyInstantIDControlNet","FaceKeypointsPreprocessor","InstantIDAttentionPatch","InstantIDFaceAnalysis","InstantIDModelLoader"],
  },
  {
    packageName: "ComfyUI-DepthAnythingV2",
    repository: "https://github.com/kijai/ComfyUI-DepthAnythingV2",
    nodeTypePrefixes: ["DepthAnything_V2","DownloadAndLoadDepthAnythingV2Model"],
  },
  {
    packageName: "mikey_nodes",
    repository: "https://github.com/bash-j/mikey_nodes",
    nodeTypePrefixes: ["AddMetaData","Batch Crop Image","Batch Crop Resize Inplace","Batch Load Images","Batch Resize Image for SDXL","Checkpoint Loader Simple Mikey","CheckpointHash","CheckpointSaveModelOnly","CinematicLook","Empty Latent Ratio Custom SDXL","Empty Latent Ratio Select SDXL","EvalFloats","FaceFixerOpenCV","FileNamePrefix","FileNamePrefixDateDirFirst","Float to String","GetSubdirectories","HaldCLUT ","Image Caption","ImageBorder","ImageOverlay","ImagePaste","Int to String","LMStudioPrompt","Load Image Based on Number","LoraSyntaxProcessor","Mikey Sampler","Mikey Sampler Base Only","Mikey Sampler Base Only Advanced","Mikey Sampler Tiled","Mikey Sampler Tiled Base Only","MikeyLatentTileSampler","MikeyLatentTileSamplerCustom","MikeySamplerTiledAdvanced","MikeySamplerTiledAdvancedBaseOnly","ModelMergePixArtSigmaXL2_1024MS","ModelMergeTrainDiff","ModelMergeTrainDiffPixartSigmaXL2_1024MS","MosaicExpandImage","OobaPrompt","PresetRatioSelector","Prompt With SDXL","Prompt With Style","Prompt With Style V2","Prompt With Style V3","Range Float","Range Integer","Ratio Advanced","RemoveTextBetween","Resize Image for SDXL","SD3TextConditioningWithOptionsOnePrompt","SRFloatPromptInput","SRIntPromptInput","SRStringPromptInput","Save Image If True","Save Image With Prompt Data","Save Images Mikey","Save Images No Display","SaveMetaData","SearchAndReplace","Seed String","Style Conditioner","Style Conditioner Base Only","Text2InputOr3rdOption","TextCombinations","TextCombinations3","TextConcat","TextPadderMikey","TextPreserve","Upscale Tile Calculator","Wildcard Processor","WildcardAndLoraSyntaxProcessor","WildcardOobaPrompt"],
  },
  {
    packageName: "audio-separation-nodes-comfyui",
    repository: "https://github.com/christian-byrne/audio-separation-nodes-comfyui",
    nodeTypePrefixes: ["AudioCombine","AudioCrop","AudioGetTempo","AudioSeparation","AudioSpeedShift","AudioTempoMatch","AudioVideoCombine"],
  },
  {
    packageName: "ComfyUI-Logic",
    repository: "https://github.com/theUpsider/ComfyUI-Logic",
    nodeTypePrefixes: ["Bool-🔬","Compare-🔬","DebugPrint-🔬","Float-🔬","If ANY return A else B-🔬","Int-🔬","String-🔬"],
  },
  {
    packageName: "Comfyui-QwenEditUtils",
    repository: "https://github.com/lrzjason/Comfyui-QwenEditUtils",
    nodeTypePrefixes: ["CropWithPadInfo","LoadImageReturnFilename","QwenEditAdaptiveLongestEdge","QwenEditAny2Image","QwenEditAny2Latent","QwenEditConfigJsonParser","QwenEditConfigPreparer","QwenEditListExtractor","QwenEditOutputExtractor","TextEncodeQwenImageEditPlusAdvance_lrzjason","TextEncodeQwenImageEditPlusCustom_lrzjason","TextEncodeQwenImageEditPlusPro_lrzjason","TextEncodeQwenImageEditPlus_lrzjason","TextEncodeQwenImageEdit_lrzjason"],
  },
  {
    packageName: "ComfyUI-post-processing-nodes",
    repository: "https://github.com/EllangoK/ComfyUI-post-processing-nodes",
    nodeTypePrefixes: ["ArithmeticBlend","AsciiArt","Blend","Blur","CannyEdgeMask","ChromaticAberration","ColorCorrect","ColorTint","Dissolve","DodgeAndBurn","FilmGrain","Glow","HSVThresholdMask","KuwaharaBlur","Parabolize","PencilSketch","PixelSort","Pixelize","Quantize","Sharpen","SineWave","Solarize","Vignette"],
  },
  {
    packageName: "ComfyUI-HunyuanVideoWrapper",
    repository: "https://github.com/kijai/ComfyUI-HunyuanVideoWrapper",
    nodeTypePrefixes: ["DownloadAndLoadHyVideoTextEncoder","HunyuanVideoFresca","HunyuanVideoSLG","HyVideoBlockSwap","HyVideoCFG","HyVideoContextOptions","HyVideoCustomPromptTemplate","HyVideoDecode","HyVideoEmptyTextEmbeds","HyVideoEncode","HyVideoEncodeKeyframes","HyVideoEnhanceAVideo","HyVideoGetClosestBucketSize","HyVideoI2VEncode","HyVideoInverseSampler","HyVideoLatentPreview","HyVideoLoopArgs","HyVideoLoraBlockEdit","HyVideoLoraSelect","HyVideoModelLoader","HyVideoPromptMixSampler","HyVideoReSampler","HyVideoSTG","HyVideoSampler","HyVideoTeaCache","HyVideoTextEmbedBridge","HyVideoTextEmbedsLoad","HyVideoTextEmbedsSave","HyVideoTextEncode","HyVideoTextImageEncode","HyVideoTorchCompileSettings","HyVideoVAELoader"],
  },
  {
    packageName: "Comfy-WaveSpeed",
    repository: "https://github.com/chengzeyi/Comfy-WaveSpeed",
    nodeTypePrefixes: ["ApplyFBCacheOnModel","EnhancedCompileModel","EnhancedLoadDiffusionModel","VelocatorCompileModel","VelocatorLoadAndQuantizeClip","VelocatorLoadAndQuantizeDiffusionModel","VelocatorQuantizeModel"],
  },
  {
    packageName: "ComfyUI-Inspyrenet-Rembg",
    repository: "https://github.com/john-mnz/ComfyUI-Inspyrenet-Rembg",
    nodeTypePrefixes: ["InspyrenetRembg","InspyrenetRembgAdvanced"],
  },
  {
    packageName: "ComfyUI-IC-Light",
    repository: "https://github.com/kijai/ComfyUI-IC-Light",
    nodeTypePrefixes: ["BackgroundScaler","CalculateNormalsFromImages","DetailTransfer","ICLightConditioning","LightSource","LoadAndApplyICLightUnet","LoadHDRImage"],
  },
  {
    packageName: "ComfyUI-Unload-Model",
    repository: "https://github.com/SeanScripts/ComfyUI-Unload-Model",
    nodeTypePrefixes: ["UnloadAllModels","UnloadModel"],
  },
  {
    packageName: "Comfyui-Resolution-Master",
    repository: "https://github.com/Azornes/Comfyui-Resolution-Master",
    nodeTypePrefixes: ["ResolutionMaster"],
  },
  {
    packageName: "ComfyUI_FaceAnalysis",
    repository: "https://github.com/cubiq/ComfyUI_FaceAnalysis",
    nodeTypePrefixes: ["FaceAlign","FaceAnalysisModels","FaceBoundingBox","FaceEmbedDistance","FaceSegmentation","FaceWarp"],
  },
  {
    packageName: "ComfyUI-WanAnimatePreprocess",
    repository: "https://github.com/kijai/ComfyUI-WanAnimatePreprocess",
    nodeTypePrefixes: ["DrawViTPose","OnnxDetectionModelLoader","PoseAndFaceDetection","PoseDetectionOneToAllAnimation","PoseRetargetPromptHelper"],
  },
  {
    packageName: "comfyui-get-meta",
    repository: "https://github.com/shinich39/comfyui-get-meta",
    nodeTypePrefixes: ["GetBooleanFromImage","GetComboFromImage","GetFloatFromImage","GetIntFromImage","GetPromptFromImage","GetStringFromImage","GetValuesFromImage","GetWorkflowFromImage"],
  },
  {
    packageName: "PuLID_ComfyUI",
    repository: "https://github.com/cubiq/PuLID_ComfyUI",
    nodeTypePrefixes: ["ApplyPulid","ApplyPulidAdvanced","PulidEvaClipLoader","PulidInsightFaceLoader","PulidModelLoader"],
  },
  {
    packageName: "ComfyUI-MMAudio",
    repository: "https://github.com/kijai/ComfyUI-MMAudio",
    nodeTypePrefixes: ["MMAudioFeatureUtilsLoader","MMAudioModelLoader","MMAudioSampler","MMAudioVoCoderLoader"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-basic_data_handling",
    repository: "https://github.com/StableLlama/ComfyUI-basic_data_handling",
    nodeTypePrefixes: ["Basic data handling: Boolean And","Basic data handling: Boolean Nand","Basic data handling: Boolean Nor","Basic data handling: Boolean Not","Basic data handling: Boolean Or","Basic data handling: Boolean Xor","Basic data handling: CastToBoolean","Basic data handling: CastToDict","Basic data handling: CastToFloat","Basic data handling: CastToInt","Basic data handling: CastToList","Basic data handling: CastToSet","Basic data handling: CastToString","Basic data handling: CompareLength","Basic data handling: ContinueFlow","Basic data handling: DataListAll","Basic data handling: DataListAny","Basic data handling: DataListAppend","Basic data handling: DataListContains","Basic data handling: DataListCount","Basic data handling: DataListCreate","Basic data handling: DataListCreateFromBoolean","Basic data handling: DataListCreateFromFloat","Basic data handling: DataListCreateFromInt","Basic data handling: DataListCreateFromString","Basic data handling: DataListEnumerate","Basic data handling: DataListExtend","Basic data handling: DataListFilter","Basic data handling: DataListFilterSelect","Basic data handling: DataListFirst","Basic data handling: DataListGetItem","Basic data handling: DataListIndex","Basic data handling: DataListInsert","Basic data handling: DataListLast","Basic data handling: DataListLength","Basic data handling: DataListListCreate","Basic data handling: DataListMax","Basic data handling: DataListMin","Basic data handling: DataListPop","Basic data handling: DataListPopRandom","Basic data handling: DataListRange","Basic data handling: DataListRemove","Basic data handling: DataListReverse","Basic data handling: DataListSetItem","Basic data handling: DataListShuffle","Basic data handling: DataListSlice","Basic data handling: DataListSort","Basic data handling: DataListSum","Basic data handling: DataListToList","Basic data handling: DataListToSet","Basic data handling: DataListZip","Basic data handling: DictCompare","Basic data handling: DictContainsKey","Basic data handling: DictCreate","Basic data handling: DictCreateFromBoolean","Basic data handling: DictCreateFromFloat","Basic data handling: DictCreateFromInt","Basic data handling: DictCreateFromItemsDataList","Basic data handling: DictCreateFromItemsList","Basic data handling: DictCreateFromLists","Basic data handling: DictCreateFromString","Basic data handling: DictExcludeKeys","Basic data handling: DictFilterByKeys","Basic data handling: DictFromKeys","Basic data handling: DictGet","Basic data handling: DictGetKeysValues","Basic data handling: DictGetMultiple","Basic data handling: DictInvert","Basic data handling: DictItems","Basic data handling: DictKeys","Basic data handling: DictLength","Basic data handling: DictMerge","Basic data handling: DictPop","Basic data handling: DictPopItem","Basic data handling: DictPopRandom","Basic data handling: DictRemove","Basic data handling: DictSet","Basic data handling: DictSetDefault","Basic data handling: DictUpdate","Basic data handling: DictValues","Basic data handling: Equal","Basic data handling: ExecutionOrder","Basic data handling: FloatAdd","Basic data handling: FloatAsIntegerRatio","Basic data handling: FloatCreate","Basic data handling: FloatDivide","Basic data handling: FloatDivideSafe","Basic data handling: FloatFromHex","Basic data handling: FloatHex","Basic data handling: FloatIsInteger","Basic data handling: FloatMultiply","Basic data handling: FloatPower","Basic data handling: FloatRound","Basic data handling: FloatSubtract","Basic data handling: FlowSelect","Basic data handling: ForceCalculation","Basic data handling: Generic And","Basic data handling: Generic Or","Basic data handling: GreaterThan","Basic data handling: GreaterThanOrEqual","Basic data handling: IfElifElse","Basic data handling: IfElse","Basic data handling: IntAdd","Basic data handling: IntBitCount","Basic data handling: IntBitLength","Basic data handling: IntCreate","Basic data handling: IntCreateWithBase","Basic data handling: IntDivide","Basic data handling: IntDivideSafe","Basic data handling: IntFromBytes","Basic data handling: IntModulus","Basic data handling: IntMultiply","Basic data handling: IntPower","Basic data handling: IntSubtract","Basic data handling: IntToBytes","Basic data handling: IsConnected","Basic data handling: IsNull","Basic data handling: LessThan","Basic data handling: LessThanOrEqual","Basic data handling: ListAll","Basic data handling: ListAny","Basic data handling: ListAppend","Basic data handling: ListContains","Basic data handling: ListCount","Basic data handling: ListCreate","Basic data handling: ListCreateFromBoolean","Basic data handling: ListCreateFromFloat","Basic data handling: ListCreateFromInt","Basic data handling: ListCreateFromString","Basic data handling: ListEnumerate","Basic data handling: ListExtend","Basic data handling: ListFirst","Basic data handling: ListGetItem","Basic data handling: ListIndex","Basic data handling: ListInsert","Basic data handling: ListLast","Basic data handling: ListLength","Basic data handling: ListMax","Basic data handling: ListMin","Basic data handling: ListPop","Basic data handling: ListPopRandom","Basic data handling: ListRange","Basic data handling: ListRemove","Basic data handling: ListReverse","Basic data handling: ListSetItem","Basic data handling: ListShuffle","Basic data handling: ListSlice","Basic data handling: ListSort","Basic data handling: ListSum","Basic data handling: ListToDataList","Basic data handling: ListToSet","Basic data handling: MathAbs","Basic data handling: MathAcos","Basic data handling: MathAsin","Basic data handling: MathAtan","Basic data handling: MathAtan2","Basic data handling: MathCeil","Basic data handling: MathCos","Basic data handling: MathDegrees","Basic data handling: MathE","Basic data handling: MathExp","Basic data handling: MathFloor","Basic data handling: MathFormula","Basic data handling: MathLog","Basic data handling: MathLog10","Basic data handling: MathMax","Basic data handling: MathMin","Basic data handling: MathPi","Basic data handling: MathRadians","Basic data handling: MathSin","Basic data handling: MathSqrt","Basic data handling: MathTan","Basic data handling: NotEqual","Basic data handling: NumberInRange","Basic data handling: PathAbspath","Basic data handling: PathBasename","Basic data handling: PathCommonPrefix","Basic data handling: PathDirname","Basic data handling: PathExists","Basic data handling: PathExpandVars","Basic data handling: PathGetCwd","Basic data handling: PathGetExtension","Basic data handling: PathGetSize","Basic data handling: PathGlob","Basic data handling: PathInputDir","Basic data handling: PathIsAbsolute","Basic data handling: PathIsDir","Basic data handling: PathIsFile","Basic data handling: PathJoin","Basic data handling: PathListDir","Basic data handling: PathLoadImageRGB","Basic data handling: PathLoadImageRGBA","Basic data handling: PathLoadMaskFromAlpha","Basic data handling: PathLoadMaskFromGreyscale","Basic data handling: PathLoadStringFile","Basic data handling: PathNormalize","Basic data handling: PathOutputDir","Basic data handling: PathRelative","Basic data handling: PathSaveImageRGB","Basic data handling: PathSaveImageRGBA","Basic data handling: PathSaveStringFile","Basic data handling: PathSetExtension","Basic data handling: PathSplit","Basic data handling: PathSplitExt","Basic data handling: RegexFindallDataList","Basic data handling: RegexFindallList","Basic data handling: RegexGroupDict","Basic data handling: RegexSearchGroupsDataList","Basic data handling: RegexSearchGroupsList","Basic data handling: RegexSplitDataList","Basic data handling: RegexSplitList","Basic data handling: RegexSub","Basic data handling: RegexTest","Basic data handling: SetAdd","Basic data handling: SetAll","Basic data handling: SetAny","Basic data handling: SetContains","Basic data handling: SetCreate","Basic data handling: SetCreateFromBoolean","Basic data handling: SetCreateFromFloat","Basic data handling: SetCreateFromInt","Basic data handling: SetCreateFromString","Basic data handling: SetDifference","Basic data handling: SetDiscard","Basic data handling: SetEnumerate","Basic data handling: SetIntersection","Basic data handling: SetIsDisjoint","Basic data handling: SetIsSubset","Basic data handling: SetIsSuperset","Basic data handling: SetLength","Basic data handling: SetPop","Basic data handling: SetPopRandom","Basic data handling: SetRemove","Basic data handling: SetSum","Basic data handling: SetSymmetricDifference","Basic data handling: SetToDataList","Basic data handling: SetToList","Basic data handling: SetUnion","Basic data handling: StringCapitalize","Basic data handling: StringCasefold","Basic data handling: StringCenter","Basic data handling: StringComparison","Basic data handling: StringConcat","Basic data handling: StringCount","Basic data handling: StringDataListJoin","Basic data handling: StringDecode","Basic data handling: StringEncode","Basic data handling: StringEndswith","Basic data handling: StringEscape","Basic data handling: StringExpandtabs","Basic data handling: StringFind","Basic data handling: StringFormatMap","Basic data handling: StringIn","Basic data handling: StringIsAlnum","Basic data handling: StringIsAlpha","Basic data handling: StringIsAscii","Basic data handling: StringIsDecimal","Basic data handling: StringIsDigit","Basic data handling: StringIsIdentifier","Basic data handling: StringIsLower","Basic data handling: StringIsNumeric","Basic data handling: StringIsPrintable","Basic data handling: StringIsSpace","Basic data handling: StringIsTitle","Basic data handling: StringIsUpper","Basic data handling: StringLength","Basic data handling: StringListJoin","Basic data handling: StringLjust","Basic data handling: StringLower","Basic data handling: StringLstrip","Basic data handling: StringRemoveprefix","Basic data handling: StringRemovesuffix","Basic data handling: StringReplace","Basic data handling: StringRfind","Basic data handling: StringRjust","Basic data handling: StringRsplitDataList","Basic data handling: StringRsplitList","Basic data handling: StringRstrip","Basic data handling: StringSplitDataList","Basic data handling: StringSplitList","Basic data handling: StringSplitlinesDataList","Basic data handling: StringSplitlinesList","Basic data handling: StringStartswith","Basic data handling: StringStrip","Basic data handling: StringSwapcase","Basic data handling: StringTitle","Basic data handling: StringUnescape","Basic data handling: StringUpper","Basic data handling: StringZfill","Basic data handling: SwitchCase","Basic data handling: TimeAddDelta","Basic data handling: TimeDelta","Basic data handling: TimeDifference","Basic data handling: TimeExtract","Basic data handling: TimeFormat","Basic data handling: TimeNow","Basic data handling: TimeNowUTC","Basic data handling: TimeParse","Basic data handling: TimeSubtractDelta","Basic data handling: TimeToUnix","Basic data handling: UnixToTime","TensorBinaryOp","TensorCreate","TensorInfo","TensorJoin","TensorPermute","TensorReshape","TensorSlice","TensorUnaryOp"],
  },
  {
    packageName: "ComfyUI_Patches_ll",
    repository: "https://github.com/lldacing/ComfyUI_Patches_ll",
    nodeTypePrefixes: ["ApplyFirstBlockCachePatch","ApplyFirstBlockCachePatchAdvanced","ApplyTeaCachePatch","ApplyTeaCachePatchAdvanced","DitForwardOverrider","FluxForwardOverrider","VideoForwardOverrider"],
  },
  {
    packageName: "comfyui-tooling-nodes",
    repository: "https://github.com/Acly/comfyui-tooling-nodes",
    nodeTypePrefixes: ["ETN_"],
  },
  {
    packageName: "cg-image-filter",
    repository: "https://github.com/chrisgoringe/cg-image-filter",
    nodeTypePrefixes: ["Any List to String","Batch from Image List","Image Filter","Image List From Batch","Mask Image Filter","Masked Section","Pick from List","Split String by Commas","StringToStringList","Text Image Filter","cg_"],
  },
  {
    packageName: "ComfyUI_BiRefNet_ll",
    repository: "https://github.com/lldacing/ComfyUI_BiRefNet_ll",
    nodeTypePrefixes: ["AutoDownloadBiRefNetModel","BlurFusionForegroundEstimation","GetMaskByBiRefNet","LoadRembgByBiRefNetModel","RembgByBiRefNet","RembgByBiRefNetAdvanced"],
  },
  {
    packageName: "ComfyUI-BrushNet",
    repository: "https://github.com/nullquant/ComfyUI-BrushNet",
    nodeTypePrefixes: ["BlendInpaint","BrushNet","BrushNetLoader","CutForInpaint","PowerPaint","PowerPaintCLIPLoader","RAUNet"],
  },
  {
    packageName: "ComfyUI-SAM2",
    repository: "https://github.com/neverbiasu/ComfyUI-SAM2",
    nodeTypePrefixes: ["GroundingDinoModelLoader (segment anything2)","GroundingDinoSAM2Segment (segment anything2)","InvertMask (segment anything)","IsMaskEmpty","SAM2ModelLoader (segment anything2)"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "COMFYUI_PROMPTMODELS",
    repository: "https://github.com/cdanielp/COMFYUI_PROMPTMODELS",
    nodeTypePrefixes: ["DivisorDePrompts","GetFrameByIndex","GetLastFrame","GoogleAI_","GrokTextNode","ImagenLatentePro","PMS_","PRO_","PromptPro","SelectorDeImagenes","SelectorDePrompts","TextPromptBlocker","TextPromptBlockerPreview"],
  },
  {
    packageName: "LanPaint",
    repository: "https://github.com/scraed/LanPaint",
    nodeTypePrefixes: ["LanPaint_"],
  },
  {
    packageName: "ComfyUI-ppm",
    repository: "https://github.com/pamparamm/ComfyUI-ppm",
    nodeTypePrefixes: ["AttentionCouplePPM","CADSPPM","CFGLimiterGuider","CFGPPSamplerSelect","CLIPAttentionSelector","CLIPMicroConditioning","CLIPNegPip","CLIPTextEncodeBREAK","CLIPTextEncodeInvertWeights","CLIPTokenCounter","ConditioningZeroOutCombine","ConvertTimestepToSigma","DynSamplerSelect","DynamicThresholdingPost","DynamicThresholdingSimplePost","EmptyLatentImageAR","EpsilonScalingPPM","FreeU2PPM","Guidance Limiter","LatentOperationTonemapLuminance","LatentToMaskBB","LatentToWidthHeight","MaskCompositePPM","ModelAttentionSelector","PPMSamplerSelect","RenormCFGPost","RescaleCFGPost","SamplerER_SDEScheduled","SamplerGradientEstimation","SamplerSEEDS2Scheduled","SkipFirstStepCFG","TCFGAdvanced","TilePreprocessorPPM"],
  },
  {
    packageName: "ComfyUI_SLK_joy_caption_two",
    repository: "https://github.com/EvilBT/ComfyUI_SLK_joy_caption_two",
    nodeTypePrefixes: ["Batch_","Joy_"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyUI-Lora-Auto-Trigger-Words",
    repository: "https://github.com/idrirap/ComfyUI-Lora-Auto-Trigger-Words",
    nodeTypePrefixes: ["FusionText","LoraListNames","LoraLoaderAdvanced","LoraLoaderStackedAdvanced","LoraLoaderStackedVanilla","LoraLoaderVanilla","LoraTagsOnly","Randomizer","TagsFormater","TagsSelector","TextInputBasic"],
  },
  {
    packageName: "ComfyUI-LTXVideo",
    repository: "https://github.com/Lightricks/ComfyUI-LTXVideo",
    nodeTypePrefixes: ["APGGuider","AddLatentGuide","DynamicConditioning","GemmaAPITextEncode","GuiderParameters","ImageToCPU","LTXAddVideoICLoRAGuide","LTXAddVideoICLoRAGuideAdvanced","LTXAttentioOverride","LTXAttentionBank","LTXAttnOverride","LTXFetaEnhance","LTXFloatToInt","LTXFlowEditCFGGuider","LTXFlowEditSampler","LTXForwardModelSamplingPred","LTXICLoRALoaderModelOnly","LTXPerturbedAttention","LTXPrepareAttnInjections","LTXQ8Patch","LTXRFForwardODESampler","LTXRFReverseODESampler","LTXReverseModelSamplingPred","LTXVAdainLatent","LTXVAddGuideAdvanced","LTXVAddGuideAdvancedAttention","LTXVAddLatentGuide","LTXVAddLatents","LTXVApplySTG","LTXVAudioOnlyEmptyVideoLatent","LTXVAudioOnlyModel","LTXVBaseSampler","LTXVDilateLatent","LTXVDilateVideoMask","LTXVDrawTracks","LTXVExtendSampler","LTXVGemmaCLIPModelLoader","LTXVGemmaEnhancePrompt","LTXVHDRDecodePostprocess","LTXVImgToVideoAdvanced","LTXVImgToVideoConditionOnly","LTXVInContextSampler","LTXVInpaintPreprocess","LTXVLaplacianPyramidBlend","LTXVLinearOverlapLatentTransition","LTXVLoadConditioning","LTXVLoopingSampler","LTXVMultiPromptProvider","LTXVNormalizingSampler","LTXVPatcherVAE","LTXVPerStepAdainPatcher","LTXVPerStepStatNormPatcher","LTXVPreprocessMasks","LTXVPromptEnhancer","LTXVPromptEnhancerLoader","LTXVQ8LoraModelLoader","LTXVSaveConditioning","LTXVSelectLatents","LTXVSetAudioRefTokens","LTXVSetAudioVideoMaskByTime","LTXVSetVideoLatentNoiseMasks","LTXVSparseTrackEditor","LTXVSpatioTemporalTiledVAEDecode","LTXVStatNormLatent","LTXVTiledSampler","LTXVTiledVAEDecode","LinearOverlapLatentTransition","LowVRAMAudioVAELoader","LowVRAMCheckpointLoader","LowVRAMLatentUpscaleModelLoader","ModifyLTXModel","MultiPromptProvider","MultimodalGuider","STGAdvancedPresets","STGGuider","STGGuiderAdvanced","STGGuiderNode","Set VAE Decoder Noise"],
    pip: { backend: "cpu", skipRequirementsTxt: true, note: "requirements pin CUDA wheels; install XPU/CPU-appropriate deps." },
  },
  {
    packageName: "ComfyMath",
    repository: "https://github.com/evanspearman/ComfyMath",
    nodeTypePrefixes: ["CM_"],
  },
  {
    packageName: "ComfyUI_AdvancedRefluxControl",
    repository: "https://github.com/kaibioinfo/ComfyUI_AdvancedRefluxControl",
    nodeTypePrefixes: ["ReduxAdvanced","StyleModelApplySimple"],
  },
  {
    packageName: "ComfyUI_Comfyroll_CustomNodes",
    repository: "https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes",
    nodeTypePrefixes: ["CR 8 Channel In","CR 8 Channel Out","CR Apply ControlNet","CR Apply LoRA Stack","CR Apply Model Merge","CR Apply Multi Upscale","CR Apply Multi-ControlNet","CR Aspect Ratio","CR Aspect Ratio Banners","CR Aspect Ratio SDXL","CR Aspect Ratio Social Media","CR Batch Images From List","CR Batch Process Switch","CR Binary Pattern","CR Binary To Bit List","CR Bit Schedule","CR Central Schedule","CR Checker Pattern","CR Clamp Value","CR Clip Input Switch","CR Color Bars","CR Color Gradient","CR Color Panel","CR Color Tint","CR Combine Prompt","CR Combine Schedules","CR Comic Panel Templates","CR Composite Text","CR Conditioning Input Switch","CR Conditioning Mixer","CR ControlNet Input Switch","CR Current Frame","CR Cycle Images","CR Cycle Images Simple","CR Cycle LoRAs","CR Cycle Models","CR Cycle Text","CR Cycle Text Simple","CR Data Bus In","CR Data Bus Out","CR Debatch Frames","CR Diamond Panel","CR Draw Pie","CR Draw Shape","CR Draw Text","CR Encode Scheduled Prompts","CR Feathered Border","CR Float Range List","CR Float To Integer","CR Float To String","CR Font File List","CR Get Parameter From Prompt","CR Gradient Float","CR Gradient Integer","CR Half Drop Panel","CR Halftone Filter","CR Halftone Grid","CR Hires Fix Process Switch","CR Image Border","CR Image Grid Panel","CR Image Input Switch","CR Image Input Switch (4 way)","CR Image List","CR Image List Simple","CR Image Output","CR Image Panel","CR Image Pipe Edit","CR Image Pipe In","CR Image Pipe Out","CR Image Size","CR Img2Img Process Switch","CR Increment Float","CR Increment Integer","CR Index","CR Index Increment","CR Index Multiply","CR Index Reset","CR Integer Multiple","CR Integer Range List","CR Integer To String","CR Interpolate Latents","CR Intertwine Lists","CR Keyframe List","CR Latent Batch Size","CR Latent Input Switch","CR LoRA List","CR LoRA Stack","CR Load Animation Frames","CR Load Flow Frames","CR Load GIF As List","CR Load Image List","CR Load Image List Plus","CR Load LoRA","CR Load Schedule From File","CR Load Scheduled LoRAs","CR Load Scheduled Models","CR Load Text List","CR Mask Text","CR Math Operation","CR Model Input Switch","CR Model List","CR Model Merge Stack","CR Module Input","CR Module Output","CR Module Pipe Loader","CR Multi Upscale Stack","CR Multi-ControlNet Stack","CR Multiline Text","CR Output Flow Frames","CR Output Schedule To File","CR Overlay Text","CR Overlay Transparent Image","CR Page Layout","CR Pipe Switch","CR Polygons","CR Prompt List","CR Prompt List Keyframes","CR Prompt Scheduler","CR Prompt Text","CR Radial Gradient","CR Random Hex Color","CR Random LoRA Stack","CR Random Multiline Colors","CR Random Multiline Values","CR Random Panel Codes","CR Random RGB","CR Random RGB Gradient","CR Random Shape Pattern","CR Random Weight LoRA","CR Repeater","CR SD1.5 Aspect Ratio","CR SDXL Aspect Ratio","CR SDXL Base Prompt Encoder","CR SDXL Prompt Mix Presets","CR SDXL Prompt Mixer","CR SDXL Style Text","CR Save Text To File","CR Schedule Input Switch","CR Seamless Checker","CR Seed","CR Seed to Int","CR Select Font","CR Select ISO Size","CR Select Model","CR Select Resize Method","CR Set Switch From String","CR Set Value On Binary","CR Set Value On Boolean","CR Set Value on String","CR Simple Banner","CR Simple Binary Pattern","CR Simple Image Compare","CR Simple List","CR Simple Meme Template","CR Simple Prompt List","CR Simple Prompt List Keyframes","CR Simple Prompt Scheduler","CR Simple Schedule","CR Simple Text Panel","CR Simple Text Scheduler","CR Simple Text Watermark","CR Simple Value Scheduler","CR Split String","CR Starburst Colors","CR Starburst Lines","CR String To Boolean","CR String To Combo","CR String To Number","CR Style Bars","CR Switch Model and CLIP","CR Text","CR Text Blacklist","CR Text Concatenate","CR Text Cycler","CR Text Input Switch","CR Text Input Switch (4 way)","CR Text Length","CR Text List","CR Text List Simple","CR Text List To String","CR Text Operation","CR Text Replace","CR Text Scheduler","CR Thumbnail Preview","CR Trigger","CR Upscale Image","CR VAE Decode","CR VAE Input Switch","CR Value","CR Value Cycler","CR Value Scheduler","CR Vignette Filter","CR XY From Folder","CR XY Index","CR XY Interpolate","CR XY List","CR XY Product","CR XY Save Grid Image","CR_Aspect Ratio For Print"],
  },
  {
    packageName: "ComfyUI_Sonic",
    repository: "https://github.com/smthemex/ComfyUI_Sonic",
    nodeTypePrefixes: ["SONICSampler","SONICTLoader","SONIC_PreData"],
  },
  {
    packageName: "ComfyUI-CaptionThis",
    repository: "https://github.com/MieMieeeee/ComfyUI-CaptionThis",
    nodeTypePrefixes: ["Florence2CaptionImageUnderDirectory|Mie","Florence2DescribeImage|Mie","Florence2ModelLoader|Mie","JanusProCaptionImageUnderDirectory|Mie","JanusProDescribeImage|Mie","JanusProModelLoader|Mie"],
  },
  {
    packageName: "ComfyUI-enricos-nodes",
    repository: "https://github.com/erosDiffusion/ComfyUI-enricos-nodes",
    nodeTypePrefixes: ["Compositor3","Compositor4","Compositor4MasksOutput","Compositor4TransformsOut","CompositorColorPicker","CompositorConfig3","CompositorConfig4","CompositorMasksOutputV3","CompositorTools3","CompositorTransformsOutV3","ImageColorSampler"],
  },
  {
    packageName: "comfyui-portrait-master-zh-cn",
    repository: "https://github.com/ZHO-ZHO-ZHO/comfyui-portrait-master-zh-cn",
    nodeTypePrefixes: ["PortraitMaster_中文版"],
  },
  {
    packageName: "ComfyUI-qwenmultiangle",
    repository: "https://github.com/jtydhr88/ComfyUI-qwenmultiangle",
    nodeTypePrefixes: ["QwenMultiangleCameraNode","QwenMultiangleCameraTranslateNode"],
  },
  {
    packageName: "ComfyUI-SCAIL-Pose",
    repository: "https://github.com/kijai/ComfyUI-SCAIL-Pose",
    nodeTypePrefixes: ["ConvertOpenPoseKeypointsToDWPose","NLFModelLoader","NLFPredictPoses","PoseDetectionVitPoseToDWPose","RenderNLFPoses","SaveNLFPosesAs3D"],
  },
  {
    packageName: "RES4LYF",
    repository: "https://github.com/ClownsharkBatwing/RES4LYF",
    nodeTypePrefixes: ["AdvancedNoise","Base64ToConditioning","BongSampler","CLIPTextEncodeFluxUnguided","ClownGuide_","ClownGuidesAB_Beta","ClownGuides_","ClownInpaint","ClownInpaintSimple","ClownModelLoader","ClownOptions_","ClownRegionalConditioning","ClownRegionalConditioning2","ClownRegionalConditioning3","ClownRegionalConditioning_","ClownRegionalConditionings","ClownSampler","ClownSamplerAdvanced","ClownSamplerAdvanced_Beta","ClownSamplerSelector_Beta","ClownSampler_Beta","ClownScheduler","ClownStyle_","ClownpileModelWanVideo","ClownsharKSampler","ClownsharKSamplerAutomation","ClownsharKSamplerAutomation_Advanced","ClownsharKSamplerGuide","ClownsharKSamplerGuides","ClownsharKSamplerOptions","ClownsharKSampler_Beta","ClownsharkChainsampler_Beta","Conditioning Recast FP64","ConditioningAdd","ConditioningAverageScheduler","ConditioningBatch4","ConditioningBatch8","ConditioningDownsample (T5)","ConditioningOrthoCollin","ConditioningToBase64","ConditioningTruncate","ConditioningZeroAndTruncate","Constant Scheduler","CrossAttn_EraseReplace_HiDream","EmptyLatentImage64","EmptyLatentImageCustom","Film Grain","FluxGuidanceDisable","FluxLoader","FluxOrthoCFGPatcher","Frame Select","Frame Select Latent","Frame Select Latent Raw","Frames Concat","Frames Concat Latent","Frames Concat Latent Raw","Frames Concat Masks","Frames Latent ReverseOrder","Frames Masks Uninterpolate","Frames Masks ZeroOut","Frames Slice","Frames Slice Latent","Frames Slice Latent Raw","Frequency Separation Hard Light","Frequency Separation Hard Light LAB","Frequency Separation Linear Light","Image Channels LAB","Image Crop Location Exact","Image Gaussian Blur","Image Get Color Swatches","Image Grain Add","Image Median Blur","Image Pair Split","Image Repeat Tile To Size","Image Sharpen FS","Latent Batcher","Latent Channels From To","Latent Clear State Info","Latent Display State Info","Latent Get Channel Means","Latent Match Channelwise","Latent Normalize Channels","Latent Replace State Info","Latent Transfer State Info","Latent TrimVideo State Info","Latent to Cuda","Latent to RawX","LatentBatch_","LatentNoiseBatch_","LatentNoiseList","LatentNoised","LatentPhaseMagnitude","LatentPhaseMagnitudeMultiply","LatentPhaseMagnitudeOffset","LatentPhaseMagnitudePower","LatentUpscaleWithVAE","LayerPatcher","Legacy_","Linear Quadratic Advanced","Mask Bounding Box Aspect Ratio","Mask Sketch","MaskEdge","MaskFloatToBoolean","MaskToggle","Masks From Color Swatches","Masks From Colors","Masks Unpack 16","Masks Unpack 4","Masks Unpack 8","ModelSamplingAdvanced","ModelSamplingAdvancedResolution","ModelTimestepPatcher","PrepForUnsampling","ReAuraPatcher","ReAuraPatcherAdvanced","ReChromaPatcher","ReChromaPatcherAdvanced","ReFluxPatcher","ReFluxPatcherAdvanced","ReHiDreamPatcher","ReHiDreamPatcherAdvanced","ReLTXVPatcher","ReLTXVPatcherAdvanced","ReReduxPatcher","ReSD35Patcher","ReSD35PatcherAdvanced","ReSDPatcher","ReWanPatcher","ReWanPatcherAdvanced","SD35Loader","SamplerOptions_","SeedGenerator","Set Precision","Set Precision Advanced","Set Precision Universal","SetImageSize","SetImageSizeWithScale","SharkChainsampler_Beta","SharkOptions_","SharkSampler_Beta","Sigmas Abs","Sigmas AdaptiveNoiseFloor","Sigmas AdaptiveStep","Sigmas Add","Sigmas Append","Sigmas ArcCosine","Sigmas ArcSine","Sigmas ArcTangent","Sigmas Attractor","Sigmas CNFInverse","Sigmas CatmullRom","Sigmas Chaos","Sigmas Cleanup","Sigmas CollatzIteration","Sigmas Concat","Sigmas ConwaySequence","Sigmas Count","Sigmas CrossProduct","Sigmas DeleteBelowFloor","Sigmas DeleteDuplicates","Sigmas DotProduct","Sigmas Easing","Sigmas Fmod","Sigmas Frac","Sigmas From Text","Sigmas GammaBeta","Sigmas Gaussian","Sigmas GaussianCDF","Sigmas GilbreathSequence","Sigmas HarmonicDecay","Sigmas Hyperbolic","Sigmas If","Sigmas InvLerp","Sigmas Iteration Karras","Sigmas Iteration Polyexp","Sigmas KernelSmooth","Sigmas LambertW","Sigmas LangevinDynamics","Sigmas Lerp","Sigmas LinearSine","Sigmas Logarithm2","Sigmas Math1","Sigmas Math3","Sigmas Modulus","Sigmas Mult","Sigmas Noise Inversion","Sigmas NormalizingFlows","Sigmas Pad","Sigmas Percentile","Sigmas PersistentHomology","Sigmas Power","Sigmas QuantileNorm","Sigmas Quotient","Sigmas ReactionDiffusion","Sigmas Recast","Sigmas Resample","Sigmas Rescale","Sigmas RiemannianFlow","Sigmas SetFloor","Sigmas Sigmoid","Sigmas SmoothStep","Sigmas Split","Sigmas Split Value","Sigmas SquareRoot","Sigmas Start","Sigmas StepwiseMultirate","Sigmas TimeStep","Sigmas Truncate","Sigmas Unpad","Sigmas Variance Floor","Sigmas ZetaEta","Sigmas2 Add","Sigmas2 Mult","SigmasPreview","SigmasSchedulePreview","StableCascade_","StyleModelApplyStyle","Tan Scheduler","Tan Scheduler 2","Tan Scheduler 2 Simple","TemporalCrossAttnMask","TemporalMaskGenerator","TemporalSplitAttnMask","TemporalSplitAttnMask (Midframe)","TextBox1","TextBox2","TextBox3","TextBoxConcatenate","TextConcatenate","TextLoadFile","TextShuffle","TextShuffleAndTruncate","TextTruncateTokens","TorchCompileModelAura","TorchCompileModelFluxAdv","TorchCompileModelSD35","TorchCompileModels","UNetSave","UltraSharkSampler","UltraSharkSampler Tiled","VAEEncodeAdvanced","VAEStyleTransferLatent"],
  },
  {
    packageName: "sd-ppp",
    repository: "https://github.com/zombieyang/sd-ppp",
    nodeTypePrefixes: ["CLIP Text Encode PS Regional","Get Image From Photoshop Layer","SDPPP Get Document","SDPPP Get Layer By ID","SDPPP Get Layers In Group","SDPPP Get Linked Layers","SDPPP Get Selection","SDPPP Get Text From Layer","SDPPP Parse Layer Info","SDPPP Select Layer And Run PS Action","Send Images To Photoshop"],
  },
];

/** Case-sensitive prefix test against a node's class_type. */
function typeMatchesPrefixes(nodeType: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => nodeType.startsWith(prefix));
}

/**
 * Return the known package that provides `nodeType` (by class_type prefix), or
 * undefined. Used to mark a node "source known" and to supply the clone repo.
 */
export function knownCustomNodeForType(nodeType: string): KnownCustomNode | undefined {
  if (!nodeType) return undefined;
  return KNOWN_CUSTOM_NODES.find((node) => typeMatchesPrefixes(nodeType, node.nodeTypePrefixes));
}

/**
 * Return the known package referenced by a free-text asset evidence string (the
 * Step-01 `wrapper_source_evidence`, which names the loader node class). Used to
 * route the package's model files (e.g. GGUF + mmproj) to its `modelSubdir`.
 */
export function knownCustomNodeForEvidence(evidence: string): KnownCustomNode | undefined {
  if (!evidence) return undefined;
  const lower = evidence.toLowerCase();
  return KNOWN_CUSTOM_NODES.find((node) =>
    node.nodeTypePrefixes.some((prefix) => lower.includes(prefix.toLowerCase()))
  );
}
