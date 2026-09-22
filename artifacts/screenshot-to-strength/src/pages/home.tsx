import { useState, useRef, ChangeEvent } from 'react';
import { useAnalyzeFitnessScreenshot, useGenerateStrengthPlan } from '@workspace/api-client-react';
import type { StrengthProgram, PlanInput } from '@workspace/api-client-react';
import { Camera, Image as ImageIcon, Utensils, Activity, Check, AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type Step = 'upload' | 'analyzing' | 'generating' | 'results';

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'error' in error.data &&
    typeof error.data.error === 'string'
  ) {
    return error.data.error;
  }
  return fallback;
}

async function prepareImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file.');
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('We could not open that image.'));
      element.src = objectUrl;
    });

    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('We could not prepare that image.');
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function Home() {
  const [step, setStep] = useState<Step>('upload');
  
  // API Mutations
  const analyzeScreenshot = useAnalyzeFitnessScreenshot();
  const generatePlan = useGenerateStrengthPlan();

  const [program, setProgram] = useState<StrengthProgram | null>(null);
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState('');

  // File Input Ref
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mealInputRef = useRef<PlanInput | null>(null);

  const requestRecoveryMeal = (planInput: PlanInput) => {
    mealInputRef.current = planInput;
    setStep('generating');
    generatePlan.reset();

    generatePlan.mutate(
      { data: planInput },
      {
        onSuccess: (data) => {
          setProgram(data);
          setStep('results');
        },
      },
    );
  };

  // Handlers
  const handleFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setStep('analyzing');
    setAnalysisErrorMessage('');
    analyzeScreenshot.reset();

    try {
      const dataUrl = await prepareImage(file);
      analyzeScreenshot.mutate(
        { data: { imageData: dataUrl } },
        {
          onSuccess: (data) => {
            requestRecoveryMeal({
              metrics: data.metrics || [],
              gaps: data.gaps || [],
              bucket: data.bucket || '',
            });
          },
          onError: (error) => {
            setAnalysisErrorMessage(
              getApiErrorMessage(
                error,
                'We could not read that image. Try another screenshot.',
              ),
            );
          }
        }
      );
    } catch (error) {
      setAnalysisErrorMessage(
        error instanceof Error ? error.message : 'We could not prepare that image.',
      );
    };
    
    // clear input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const resetFlow = () => {
    setStep('upload');
    setProgram(null);
    mealInputRef.current = null;
    analyzeScreenshot.reset();
    generatePlan.reset();
    setAnalysisErrorMessage('');
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center bg-background text-foreground pb-20">
      <header className="w-full pf-topbar">
        <div className="w-full max-w-6xl mx-auto px-5 sm:px-8 py-5 flex items-center justify-between gap-5">
          <img
            src={`${import.meta.env.BASE_URL}pfsa-logo.png`}
            alt="Planet Fitness"
            className="pf-logo"
          />
          <a
            href="https://www.planetfitness.co.za"
            target="_blank"
            rel="noopener noreferrer"
            className="pf-toplink"
          >
            Find a club
          </a>
        </div>
      </header>

      <main className="w-full max-w-6xl mx-auto px-4 sm:px-8 flex flex-col gap-6">
        
        {/* === STEP: UPLOAD === */}
        {step === 'upload' && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col gap-8">
            <section className="pf-hero">
              <div className="pf-hero-copy">
                <p className="pf-kicker">Screenshot to recovery</p>
                <h1 className="pf-hero-title">YOUR SESSION.<br /><span>REFUELLED.</span></h1>
                <p className="pf-hero-body">
                  Show us what you did. We’ll suggest one quick meal to help put back what you used.
                </p>
              </div>
              <div className="pf-hero-art" aria-hidden="true">
                <div className="pf-art-ring pf-art-ring-one" />
                <div className="pf-art-ring pf-art-ring-two" />
                <div className="pf-art-bars">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <span className="pf-art-label">MOVE<br />REFUEL</span>
              </div>
            </section>

            <Card className="border-0 bg-card rounded-none pf-upload-panel">
              <CardContent className="p-6 sm:p-10 flex flex-col justify-center gap-6">
                <div className="flex items-start gap-4">
                  <div className="pf-icon-block">
                    <Camera className="w-7 h-7" />
                  </div>
                  <div className="space-y-2">
                    <p className="pf-section-kicker">Start with what you have</p>
                    <h2 className="text-2xl sm:text-3xl font-display font-bold text-foreground">Show us your session</h2>
                    <p className="text-muted-foreground max-w-lg text-sm sm:text-base leading-relaxed">
                      Add a treadmill screen, smartwatch summary, or activity screenshot. We’ll go straight to your meal.
                    </p>
                  </div>
                </div>

                <input 
                  type="file" 
                  accept="image/*" 
                  capture="environment" 
                  className="hidden" 
                  ref={fileInputRef} 
                  onChange={handleFileSelect}
                />
                
                <Button 
                  size="lg" 
                  className="w-full rounded-none h-14 text-base sm:text-lg font-bold" 
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImageIcon className="mr-2 h-5 w-5" />
                  Choose an image
                </Button>

              </CardContent>
            </Card>
          </div>
        )}


        {/* === STEP: ANALYZING === */}
        {step === 'analyzing' && (
          <div className="animate-in fade-in zoom-in-95 duration-500 flex flex-col items-center justify-center py-20 gap-8">
            {!analyzeScreenshot.isError && !analysisErrorMessage ? (
              <>
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse"></div>
                  <Activity className="w-16 h-16 text-primary animate-bounce relative z-10" />
                </div>
                <div className="text-center space-y-2">
                  <h2 className="text-2xl font-display font-bold">Reading Image</h2>
                  <p className="text-muted-foreground">Scanning for your stats...</p>
                </div>
                <Button variant="ghost" className="rounded-none mt-4 text-muted-foreground" onClick={resetFlow}>
                  Cancel
                </Button>
              </>
            ) : (
              <Alert variant="destructive" className="rounded-none border-l-4 border-l-destructive bg-destructive/10">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <AlertTitle className="text-destructive font-bold text-sm">Error</AlertTitle>
                <AlertDescription className="text-destructive/90 mt-1">
                  {analysisErrorMessage || getApiErrorMessage(
                    analyzeScreenshot.error,
                     'We could not read that image. Try another screenshot.',
                  )}
                </AlertDescription>
                <div className="mt-4">
                  <Button variant="outline" className="rounded-none border-destructive text-destructive hover:bg-destructive/20" onClick={resetFlow}>
                    Try another image
                  </Button>
                </div>
              </Alert>
            )}
          </div>
        )}

        {/* === STEP: GENERATING === */}
        {step === 'generating' && (
          <div className="animate-in fade-in zoom-in-95 duration-500 flex flex-col items-center justify-center py-20 gap-8">
            {!generatePlan.isError ? (
              <>
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse delay-75"></div>
                  <Utensils className="w-16 h-16 text-primary animate-pulse relative z-10" />
                </div>
                <div className="text-center space-y-2">
                  <h2 className="text-2xl font-display font-bold">Finding Your Meal</h2>
                  <p className="text-muted-foreground">Putting together something quick and satisfying.</p>
                </div>
                <Button variant="ghost" className="rounded-none mt-4 text-muted-foreground" onClick={resetFlow}>
                  Cancel
                </Button>
              </>
            ) : (
              <Alert variant="destructive" className="rounded-none border-l-4 border-l-destructive bg-destructive/10">
                <AlertCircle className="h-5 w-5 text-destructive" />
                <AlertTitle className="text-destructive font-bold text-sm">Error</AlertTitle>
                <AlertDescription className="text-destructive/90 mt-1">
                  We had trouble finding your meal. This might be a network issue.
                </AlertDescription>
                <div className="mt-4 flex gap-4">
                  <Button variant="outline" className="rounded-none border-destructive text-destructive hover:bg-destructive/20" onClick={resetFlow}>
                    Start Over
                  </Button>
                  <Button
                    className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => mealInputRef.current && requestRecoveryMeal(mealInputRef.current)}
                  >
                    Try Again
                  </Button>
                </div>
              </Alert>
            )}
          </div>
        )}

        {/* === STEP: RESULTS === */}
        {step === 'results' && program && (
          <div className="animate-in fade-in slide-in-from-bottom-8 duration-700 flex flex-col gap-8 pb-10">
            
            <div className="space-y-4 text-center">
              <div className="mx-auto bg-primary text-primary-foreground w-16 h-16 flex items-center justify-center rounded-none mb-6 animate-in zoom-in spin-in-12 duration-700">
                <Check className="w-8 h-8" />
              </div>
              <p className="pf-kicker">Your recovery meal</p>
              <p className="text-lg text-muted-foreground max-w-md mx-auto leading-relaxed">
                {program.summary}
              </p>
            </div>

            <Card className="border-0 bg-secondary rounded-none text-secondary-foreground mt-4">
              <CardHeader>
                <CardTitle className="text-2xl font-display text-primary">Your Recovery Recipe</CardTitle>
                <CardDescription className="text-secondary-foreground/80">
                  Something simple and satisfying after your session.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="bg-background/15 p-5 border-l-4 border-l-primary">
                  <h4 className="text-2xl font-display font-bold text-primary">
                    {program.recoveryRecipe.name}
                  </h4>
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {program.recoveryRecipe.ingredients.map((ingredient, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-secondary-foreground/90">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                        <span>{ingredient}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-3 leading-relaxed text-secondary-foreground/90">
                  <p>{program.recoveryRecipe.howToMake}</p>
                  <p className="font-medium text-secondary-foreground">
                    {program.recoveryRecipe.whyItFits}
                  </p>
                </div>

                <div className="text-xs text-secondary-foreground/55 pt-3 border-t border-secondary-foreground/10">
                  General guidance only, not personalised medical or nutrition advice.
                </div>
              </CardContent>
            </Card>

            <div className="pt-8 pb-12 flex flex-col gap-6 items-center border-t border-border mt-4">
              <p className="text-center text-lg font-medium">
                Ready to crush it? Visit Planet Fitness to find your nearest club.
              </p>
              <a 
                href="https://www.planetfitness.co.za" 
                target="_blank" 
                rel="noopener noreferrer"
                className="w-full"
              >
                <Button size="lg" className="w-full rounded-none h-16 text-xl font-display font-black tracking-widest bg-primary text-primary-foreground hover:bg-primary/90">
                  Find a Club
                </Button>
              </a>
              <Button variant="ghost" className="text-muted-foreground text-sm font-bold tracking-widest" onClick={resetFlow}>
                Start New Plan
              </Button>
            </div>

          </div>
        )}

      </main>
    </div>
  );
}
